import path from "node:path";
import fs from "node:fs/promises";
import { OpenAIClient } from "../ai/openai-client.js";
import { ResolvedCompileConfig } from "../config/types.js";
import {
  inferNodePackageVersion,
  listManagedScaffoldPaths,
  loadManagedScaffoldFiles,
  shouldUseDevDependency
} from "./scaffold.js";
import { RuntimeFailure, runRuntimeValidation } from "./runtime.js";
import { emitGeneratedProject } from "../emitter/project-emitter.js";
import { loadSpecProject } from "../spec/loader.js";
import { parseSpecProject } from "../spec/parser.js";
import { ensureDirectory, writeJsonFile, writeTextFile } from "../utils/fs.js";
import { createLogger } from "../utils/logger.js";

export type GeneratedFile = {
  path: string;
  content: string;
};

export type CompileResult = {
  files: GeneratedFile[];
  warnings: string[];
};

type StreamParseState = {
  buffer: string;
  transcript: string;
  files: Map<string, string>;
};

type CompileTarget = "frontend" | "backend";
type RepairPassResult = {
  files: GeneratedFile[];
  appliedFixes: number;
  transcript: string;
  success: boolean;
  failureReasons: string[];
};

export async function compileSpecProject(
  config: ResolvedCompileConfig
): Promise<CompileResult> {
  const logger = createLogger(config.compile.verbose);

  logger.step("1/7", `Loading spec project from ${config.projectDir}`);
  const project = await loadSpecProject(config.projectDir, config.outDir);

  logger.step("2/7", "Validating spec files");
  const warnings = validateSpecFiles(project.files.map(file => file.relativePath));
  for (const warning of warnings) {
    logger.warn(warning);
  }

  if (config.compile.clean) {
    await fs.rm(config.outDir, { recursive: true, force: true });
  }
  await ensureDirectory(config.outDir);

  const client = new OpenAIClient({
    host: config.host,
    auth: config.auth,
    timeout: config.timeout
  });

  const planMessages = buildPlanMessages(project.promptContext, config);
  logger.step("3/7", "Requesting AI compile plan");
  logger.debug(config.compile.debug, "plan request", JSON.stringify(planMessages, null, 2));
  const compilePlan = await client.streamChatCompletion(
    {
      model: config.model,
      temperature: config.ai.temperature,
      messages: planMessages
    },
    chunk => {
      process.stdout.write(chunk);
    }
  );
  process.stdout.write("\n");

  const targets = detectCompileTargets(project.promptContext, config);
  if (targets.length === 0) {
    throw new Error("No compile targets selected. Check the spec Environment or stack config.");
  }

  const managedScaffoldFiles = await loadManagedScaffoldFiles(config.projectDir, project.promptContext, config.stack);
  const managedScaffoldPaths = new Set(listManagedScaffoldPaths());
  for (const scaffoldFile of managedScaffoldFiles) {
    await writeGeneratedFile(config.outDir, scaffoldFile);
  }

  logger.step(
    "4/7",
    `Generating project files with ${targets.join(" + ")} agent(s)${
      targets.length > 1 ? " in parallel" : ""
    }`
  );
  const transcripts: Partial<Record<CompileTarget, string>> = {};
  const promptTraceByTarget: Partial<Record<CompileTarget, ReturnType<typeof buildGenerationMessages>>> = {};
  const filesMap = new Map<string, string>(
    managedScaffoldFiles.map(file => [file.path, file.content])
  );
  const generationTasks = targets.map(async target => {
    const targetState: StreamParseState = {
      buffer: "",
      transcript: "",
      files: filesMap
    };

    const generationMessages = buildGenerationMessages(
      target,
      project.promptContext,
      compilePlan,
      config
    );
    promptTraceByTarget[target] = generationMessages;

    logger.step(
      target === "frontend" ? "4a/7" : "4b/7",
      `Running ${target} agent`
    );
    logger.debug(
      config.compile.debug,
      `${target} generate request`,
      JSON.stringify(generationMessages, null, 2)
    );

    await client.streamChatCompletion(
      {
        model: config.model,
        temperature: config.ai.temperature,
        messages: generationMessages
      },
      async chunk => {
        writeTargetChunk(target, chunk, targets.length > 1);
        await consumeGenerationChunk(
          chunk,
          targetState,
          config,
          logger,
          target,
          managedScaffoldPaths
        );
      }
    );

    process.stdout.write("\n");
    await flushCompletedFileBlocks(
      targetState,
      config,
      logger,
      target,
      managedScaffoldPaths
    );
    transcripts[target] = targetState.transcript;
  });

  try {
    await Promise.all(generationTasks);
  } catch (error) {
    await writeDebugFailureArtifacts({
      outDir: config.outDir,
      planMessages,
      compilePlan,
      generationMessagesByTarget: promptTraceByTarget,
      generationTranscriptsByTarget: transcripts,
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }

  const files = Array.from(filesMap.entries()).map(([filePath, content]) => ({
    path: filePath,
    content
  }));

  if (files.length === 0) {
    await writeDebugFailureArtifacts({
      outDir: config.outDir,
      planMessages,
      compilePlan,
      generationMessagesByTarget: promptTraceByTarget,
      generationTranscriptsByTarget: transcripts,
      errorMessage: "No file blocks were parsed from the streamed model output."
    });
    throw new Error(
      "AI compile output did not contain any parsable file blocks. Use --debug and check dist/.specos/prompt-trace.json."
    );
  }

  const artifactValidation = validateGeneratedArtifacts(files, targets, project.promptContext);
  for (const warning of artifactValidation.warnings) {
    logger.warn(warning);
    warnings.push(warning);
  }

  logger.step("5/7", "Running AI static review and repair");
  const deterministicRepair = await applyDeterministicRepairs({
    files,
    targets,
    outDir: config.outDir,
    logger,
    debug: config.compile.debug
  });
  const filesForReview = deterministicRepair.files;
  if (deterministicRepair.appliedFixes > 0) {
    warnings.push(
      `Deterministic static repair applied ${deterministicRepair.appliedFixes} file fix${
        deterministicRepair.appliedFixes === 1 ? "" : "es"
      }`
    );
  }

  const repairResult = await runAiStaticReviewAndRepair({
    client,
    config,
    logger,
    targets,
    specContext: project.promptContext,
    compilePlan,
    files: filesForReview,
    outDir: config.outDir,
    initialValidationErrors: validateGeneratedArtifacts(
      filesForReview,
      targets,
      project.promptContext
    ).errors
      .filter(error => !managedScaffoldPaths.has(extractFilePathFromValidationError(error) ?? "")),
    managedScaffoldPaths
  });
  const repairedFiles = repairResult.files;
  if (repairResult.appliedFixes > 0) {
    warnings.push(
      `AI static review applied ${repairResult.appliedFixes} file fix${
        repairResult.appliedFixes === 1 ? "" : "es"
      }`
    );
  }

  const repairedValidation = validateGeneratedArtifacts(
    repairedFiles,
    targets,
    project.promptContext
  );
  for (const warning of repairedValidation.warnings) {
    logger.warn(warning);
    warnings.push(warning);
  }

  if (!repairResult.success || repairedValidation.errors.length > 0) {
    const failureReasons = [
      ...repairResult.failureReasons,
      ...repairedValidation.errors
    ];
    const uniqueFailureReasons = Array.from(new Set(failureReasons));
    const formattedFailure = formatFailureReport(
      "Compile failed after 3 AI static review passes.",
      uniqueFailureReasons
    );
    await writeDebugFailureArtifacts({
      outDir: config.outDir,
      planMessages,
      compilePlan,
      generationMessagesByTarget: promptTraceByTarget,
      generationTranscriptsByTarget: transcripts,
      errorMessage: formattedFailure,
      staticReviewTranscript: repairResult.transcript
    });
    throw new Error(formattedFailure);
  }

  logger.step("6/7", "Running runtime validation and repair");
  const runtimeRepairResult = await runAiRuntimeReviewAndRepair({
    client,
    config,
    logger,
    targets,
    specContext: project.promptContext,
    compilePlan,
    files: repairedFiles,
    outDir: config.outDir
  });
  const runtimeRepairedFiles = runtimeRepairResult.files;
  if (runtimeRepairResult.appliedFixes > 0) {
    warnings.push(
      `AI runtime review applied ${runtimeRepairResult.appliedFixes} file fix${
        runtimeRepairResult.appliedFixes === 1 ? "" : "es"
      }`
    );
  }

  if (!runtimeRepairResult.success) {
    const uniqueFailureReasons = Array.from(new Set(runtimeRepairResult.failureReasons));
    const formattedFailure = formatFailureReport(
      "Compile failed after 3 AI runtime repair passes.",
      uniqueFailureReasons
    );
    await writeDebugFailureArtifacts({
      outDir: config.outDir,
      planMessages,
      compilePlan,
      generationMessagesByTarget: promptTraceByTarget,
      generationTranscriptsByTarget: transcripts,
      errorMessage: formattedFailure,
      staticReviewTranscript: repairResult.transcript,
      runtimeReviewTranscript: runtimeRepairResult.transcript
    });
    throw new Error(formattedFailure);
  }

  logger.step("7/7", `Finalizing compile output in ${config.outDir}`);
  await emitGeneratedProject({
    outDir: config.outDir,
    clean: false,
    files: runtimeRepairedFiles,
    metadata: {
      generatedAt: new Date().toISOString(),
      projectDir: config.projectDir,
      model: config.model,
      summary: `Generated ${runtimeRepairedFiles.length} files from streamed code blocks.`,
      warnings
    },
    promptTrace: {
      plan: planMessages,
      compilePlan,
      targets,
      generateByTarget: promptTraceByTarget,
      generationTranscriptsByTarget: transcripts,
      staticReview: {
        appliedFixes: repairResult.appliedFixes,
        transcript: repairResult.transcript
      },
      runtimeReview: {
        appliedFixes: runtimeRepairResult.appliedFixes,
        transcript: runtimeRepairResult.transcript
      },
      protocol: getFileBlockProtocolDescription()
    }
  });

  return {
    files: runtimeRepairedFiles,
    warnings
  };
}

function writeTargetChunk(
  target: CompileTarget,
  chunk: string,
  prefixOutput: boolean
): void {
  if (!prefixOutput) {
    process.stdout.write(chunk);
    return;
  }

  const label = `[${target}] `;
  const normalized = chunk.replace(/\n/g, `\n${label}`);
  process.stdout.write(`${label}${normalized}`);
}

async function consumeGenerationChunk(
  chunk: string,
  state: StreamParseState,
  config: ResolvedCompileConfig,
  logger: ReturnType<typeof createLogger>,
  target: CompileTarget,
  managedScaffoldPaths: Set<string>
): Promise<void> {
  state.buffer += chunk;
  state.transcript += chunk;
  await flushCompletedFileBlocks(state, config, logger, target, managedScaffoldPaths);
}

async function flushCompletedFileBlocks(
  state: StreamParseState,
  config: ResolvedCompileConfig,
  logger: ReturnType<typeof createLogger>,
  target: CompileTarget,
  managedScaffoldPaths: Set<string>
): Promise<void> {
  while (true) {
    const match = matchNextCompletedFileBlock(state.buffer);
    if (!match) {
      break;
    }

    const generatedFile = normalizeGeneratedFile(match.path, match.content);
    if (managedScaffoldPaths.has(generatedFile.path)) {
      logger.step(`skip:${target}`, `${generatedFile.path} (compiler-managed scaffold)`);
      state.buffer = state.buffer.slice(match.endIndex);
      continue;
    }

    state.files.set(generatedFile.path, generatedFile.content);
    await writeGeneratedFile(config.outDir, generatedFile);
    logger.step(`write:${target}`, generatedFile.path);

    state.buffer = state.buffer.slice(match.endIndex);
  }
}

function matchNextCompletedFileBlock(input: string):
  | {
      path: string;
      content: string;
      endIndex: number;
    }
  | undefined {
  const normalizedInput = input.replace(/\r\n/g, "\n");
  const fileHeaderMatch = /FILE:\s*([^\n]+)\n```([a-zA-Z0-9._+-]*)?\n/.exec(normalizedInput);
  if (!fileHeaderMatch || fileHeaderMatch.index === undefined) {
    return undefined;
  }

  const contentStart = fileHeaderMatch.index + fileHeaderMatch[0].length;
  const fenceEndIndex = normalizedInput.indexOf("\n```", contentStart);
  if (fenceEndIndex === -1) {
    const eofFenceIndex = normalizedInput.indexOf("```", contentStart);
    if (eofFenceIndex === -1) {
      return undefined;
    }

    return {
      path: fileHeaderMatch[1].trim(),
      content: normalizedInput.slice(contentStart, eofFenceIndex),
      endIndex: eofFenceIndex + "```".length
    };
  }

  return {
    path: fileHeaderMatch[1].trim(),
    content: normalizedInput.slice(contentStart, fenceEndIndex),
    endIndex: fenceEndIndex + "\n```".length
  };
}

function buildPlanMessages(specContext: string, config: ResolvedCompileConfig) {
  return [
    {
      role: "system" as const,
      content:
        "You are the SpecOS planning agent. The spec is the single source of truth. If the requested stack, routes, fields, validations, actions, or behavior in the spec conflict with any prior assumption, follow the spec exactly. Produce a concise, operational, step-based compile plan for a runnable project and explicitly cover frontend/backend integration, API contracts, entrypoints, routing, and local development behavior."
    },
    {
      role: "user" as const,
      content: `Project stack:
Frontend: ${config.stack.frontend.framework} ${config.stack.frontend.frameworkVersion ?? ""}
UI: ${config.stack.frontend.ui} ${config.stack.frontend.uiVersion ?? ""}
Frontend language: ${config.stack.frontend.language} ${config.stack.frontend.languageVersion ?? ""}
Frontend runtime: http://${config.stack.frontend.host}:${config.stack.frontend.port}
Backend: ${config.stack.backend.framework} ${config.stack.backend.frameworkVersion ?? ""}
Backend language: ${config.stack.backend.language} ${config.stack.backend.languageVersion ?? ""}
Backend runtime: http://${config.stack.backend.host}:${config.stack.backend.port}
Database: ${config.stack.data.engine} ${config.stack.data.engineVersion ?? ""}
Database URI: ${config.stack.data.uri}

Spec project:
${specContext}

Explain the compile plan and major files you will create.

Planning rules:
- Treat the spec as authoritative and do not invent entities, fields, routes, or actions.
- Call out exact page routes, API endpoints, state sources, and validation rules you must implement.
- Ensure the generated frontend and backend will run together locally after dependencies are installed.
- Ensure the plan accounts for browser routing, API proxy/CORS, and frontend/backend data contract alignment.
- Place shared environment, database, and deployment/runtime configuration templates at the generated project root, not inside frontend/ or backend/, unless a framework requires a local file.`
    }
  ];
}

function buildGenerationMessages(
  target: CompileTarget,
  specContext: string,
  compilePlan: string,
  config: ResolvedCompileConfig
) {
  const targetInstructions = getTargetInstructions(target, config);

  return [
    {
      role: "system" as const,
      content:
        `You are the SpecOS ${target} compile agent. The spec is the single source of truth. Generate executable project files, not JSON. Stream the answer as code blocks only. Each file must start with \`FILE: relative/path\` on its own line, followed immediately by a fenced code block. You may emit the same file path again later with a more complete version; the compiler will treat the latest block as the current file content. If the compile plan conflicts with the spec, obey the spec. Emit code that is runnable after dependency installation and keep the frontend/backend contract internally consistent.`
    },
    {
      role: "user" as const,
      content: `Generate ${target} project files using:
- Frontend: ${config.stack.frontend.framework} ${config.stack.frontend.frameworkVersion ?? ""}
- UI Library: ${config.stack.frontend.ui} ${config.stack.frontend.uiVersion ?? ""}
- Frontend language: ${config.stack.frontend.language} ${config.stack.frontend.languageVersion ?? ""}
- Frontend runtime: http://${config.stack.frontend.host}:${config.stack.frontend.port}
- Backend: ${config.stack.backend.framework} ${config.stack.backend.frameworkVersion ?? ""}
- Backend language: ${config.stack.backend.language} ${config.stack.backend.languageVersion ?? ""}
- Backend runtime: http://${config.stack.backend.host}:${config.stack.backend.port}
- Database: ${config.stack.data.engine} ${config.stack.data.engineVersion ?? ""}
- Database URI: ${config.stack.data.uri}

Use this compile plan from the previous step as a hard guide for file layout, implementation order, and module boundaries:
${compilePlan.trim() || "(empty plan output)"}

Target-specific requirements:
${targetInstructions}

Output protocol:
FILE: frontend/src/App.tsx
\`\`\`tsx
export function App() {
  return <div>App</div>;
}
\`\`\`

Rules:
- Output executable code and config files, not a JSON manifest.
- Use only the FILE + fenced code block protocol.
- Do not add explanations outside file blocks.
- Use relative paths only.
- Generate a minimal but coherent full-stack project.
- If you are the frontend agent, only emit frontend or shared client-facing files.
- If you are the backend agent, only emit backend or shared server-facing files.
- Do not emit compiler-managed scaffold files such as frontend/package.json, frontend/index.html, frontend/tsconfig.json, frontend/vite.config.ts, frontend/src/vite-env.d.ts, backend/requirements.txt, or root .env.example.
- Prefer complete file replacements if you revise a file later in the stream.
- The generated code must be runnable, not illustrative pseudocode.
- Follow the spec exactly for route paths, field names, labels, validations, actions, and state wiring.
- Do not invent extra pages, entities, fields, actions, or API shapes unless they are required by the chosen framework to make the project run.
- Keep naming aligned across the stack. If the spec says \`name\`, \`age\`, \`sex\`, and \`city\`, those names must stay consistent in forms, API payloads, storage, and table rendering.
- Frontend/backend integration must work in local development without browser CORS failures or broken base URLs.
- Every imported third-party frontend package must be declared in frontend/package.json dependencies or devDependencies. Every imported third-party backend package must be declared in backend dependency files.
- Prefer boring, dependable framework patterns over clever abstractions.

Spec project:
${specContext}`
    }
  ];
}

function getTargetInstructions(target: CompileTarget, config: ResolvedCompileConfig): string {
  if (target === "frontend") {
    return `Focus on ${config.stack.frontend.framework} ${config.stack.frontend.frameworkVersion ?? ""} + ${config.stack.frontend.ui} ${config.stack.frontend.uiVersion ?? ""} + ${config.stack.frontend.language} ${config.stack.frontend.languageVersion ?? ""}. Emit business-facing frontend files under frontend/, especially frontend/src/. Implement a complete runnable frontend app, not just isolated components. The compiler already provides frontend/package.json, frontend/index.html, frontend/tsconfig.json, frontend/vite.config.ts, frontend/src/vite-env.d.ts, backend/requirements.txt, and root .env.example; do not emit or replace those scaffold files. Also implement pages, components, API client calls, and route wiring. Environment requirements: target Node ${config.stack.frontend.nodeVersion ?? "18"}+ compatibility; assume a Vite + ${config.stack.frontend.framework} + ${config.stack.frontend.language} scaffold already exists; do not switch toolchains. Routing library requirements: the managed scaffold uses react-router-dom v6, so use v6 APIs only. Use \`Routes\`, \`Route\`, and \`Navigate\`; do not use deprecated v5 APIs such as \`Switch\`, \`Redirect\`, or \`component=\`. Networking requirements: do not hardcode absolute browser API URLs such as \`${config.stack.frontend.proxyTarget}\` in frontend code; call backend APIs through same-origin relative paths such as \`${config.stack.frontend.apiBasePath}\`. Routing requirements: if the spec defines one or more page paths such as \`/users\`, the generated app must still render successfully at \`/\`; add a default route that redirects or navigates from \`/\` to the primary page, and add a catch-all fallback route that redirects unknown paths to a valid page instead of rendering a 404. Spec compliance requirements: preserve each page path exactly as written in the spec, render the correct page content for that route, and ensure UI field names, validation rules, and actions match the spec. Do not emit backend runtime code files.`;
  }

  return `Focus on ${config.stack.backend.framework} ${config.stack.backend.frameworkVersion ?? ""} + ${config.stack.data.engine} ${config.stack.data.engineVersion ?? ""}. Emit executable backend code under backend/, such as backend/${config.stack.backend.entry}, route modules, services, and models. Do not emit environment scaffold files. The compiler already provides backend/requirements.txt and root .env.example; do not emit or replace them. Networking requirements: generated backend APIs should be compatible with a frontend dev server on http://localhost:${config.stack.frontend.port}; when appropriate, expose API routes under an ${config.stack.frontend.apiBasePath} prefix and include local-development CORS support for ${config.stack.backend.corsOrigins.join(", ")} so browser requests are not blocked if the frontend is served separately. Spec compliance requirements: action inputs, storage fields, validation rules, and response payloads must match the spec and stay consistent with the frontend-facing API contract. Do not emit frontend runtime code files.`;
}

function detectCompileTargets(
  specContext: string,
  config: ResolvedCompileConfig
): CompileTarget[] {
  const targets: CompileTarget[] = [];

  if (!isTargetDisabled("frontend", specContext, config)) {
    targets.push("frontend");
  }

  if (!isTargetDisabled("backend", specContext, config)) {
    targets.push("backend");
  }

  return targets;
}

function isTargetDisabled(
  target: CompileTarget,
  specContext: string,
  config: ResolvedCompileConfig
): boolean {
  const stackValue = target === "frontend"
    ? config.stack.frontend.framework
    : config.stack.backend.framework;
  if (isDisabledValue(stackValue)) {
    return true;
  }

  const pattern = target === "frontend" ? /Frontend:\s*([^\n]+)/i : /Backend:\s*([^\n]+)/i;
  const match = specContext.match(pattern);
  if (!match) {
    return false;
  }

  return isDisabledValue(match[1]);
}

function isDisabledValue(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return ["none", "no", "false", "disabled", "disable", "null", "n/a"].includes(normalized);
}

function validateSpecFiles(files: string[]): string[] {
  const warnings: string[] = [];

  if (!files.some(file => path.basename(file) === "app.spec")) {
    warnings.push("No app.spec file found. Compile will still proceed using every .spec file.");
  }

  return warnings;
}

function normalizeGeneratedFile(filePath: string, content: string): GeneratedFile {
  const normalizedPath = filePath.replace(/^\/+/, "").trim();

  if (
    normalizedPath.startsWith("..") ||
    normalizedPath.includes(`..${path.sep}`) ||
    normalizedPath.includes("../") ||
    path.isAbsolute(normalizedPath)
  ) {
    throw new Error(`AI compile response included an unsafe output path: ${filePath}`);
  }

  return {
    path: normalizedPath,
    content: content.replace(/\s+$/, "") + "\n"
  };
}

async function writeGeneratedFile(outDir: string, file: GeneratedFile): Promise<void> {
  const targetPath = path.join(outDir, file.path);
  await ensureDirectory(path.dirname(targetPath));
  await writeTextFile(targetPath, file.content);
}

async function writeDebugFailureArtifacts(input: {
  outDir: string;
  planMessages: ReturnType<typeof buildPlanMessages>;
  compilePlan: string;
  generationMessagesByTarget: Partial<Record<CompileTarget, ReturnType<typeof buildGenerationMessages>>>;
  generationTranscriptsByTarget: Partial<Record<CompileTarget, string>>;
  errorMessage: string;
  staticReviewTranscript?: string;
  runtimeReviewTranscript?: string;
}): Promise<void> {
  const metaDir = path.join(input.outDir, ".specos");
  await ensureDirectory(metaDir);
  await writeJsonFile(path.join(metaDir, "prompt-trace.json"), {
    plan: input.planMessages,
    compilePlan: input.compilePlan,
    generateByTarget: input.generationMessagesByTarget,
    generationTranscriptsByTarget: input.generationTranscriptsByTarget,
    staticReview: input.staticReviewTranscript
      ? { transcript: input.staticReviewTranscript }
      : undefined,
    runtimeReview: input.runtimeReviewTranscript
      ? { transcript: input.runtimeReviewTranscript }
      : undefined,
    protocol: getFileBlockProtocolDescription(),
    error: input.errorMessage
  });
}

function getFileBlockProtocolDescription(): string {
  return "Each generated file must be emitted as `FILE: relative/path` followed by a fenced code block. Later blocks for the same path replace the previous file content.";
}

async function applyDeterministicRepairs(input: {
  files: GeneratedFile[];
  targets: CompileTarget[];
  outDir: string;
  logger: ReturnType<typeof createLogger>;
  debug: boolean;
}): Promise<{ files: GeneratedFile[]; appliedFixes: number }> {
  const filesMap = new Map(input.files.map(file => [file.path, file.content]));
  let appliedFixes = 0;

  if (input.targets.includes("frontend")) {
    const packageJsonPath = "frontend/package.json";
    const packageJsonContent = filesMap.get(packageJsonPath);
    if (packageJsonContent) {
      const nextPackageJson = repairFrontendPackageManifest(
        packageJsonContent,
        input.files.filter(file => file.path.startsWith("frontend/"))
      );
      if (nextPackageJson && nextPackageJson !== packageJsonContent) {
        filesMap.set(packageJsonPath, nextPackageJson);
        await writeGeneratedFile(input.outDir, {
          path: packageJsonPath,
          content: nextPackageJson
        });
        appliedFixes += 1;
        input.logger.debug(
          input.debug,
          "deterministic repair frontend/package.json",
          nextPackageJson
        );
      }
    }

    const indexPath = filesMap.has("frontend/src/index.tsx")
      ? "frontend/src/index.tsx"
      : filesMap.has("frontend/src/index.jsx")
        ? "frontend/src/index.jsx"
        : undefined;
    if (indexPath) {
      const indexContent = filesMap.get(indexPath) ?? "";
      const nextIndexContent = repairFrontendEntryFile(indexContent);
      if (nextIndexContent && nextIndexContent !== indexContent) {
        filesMap.set(indexPath, nextIndexContent);
        await writeGeneratedFile(input.outDir, {
          path: indexPath,
          content: nextIndexContent
        });
        appliedFixes += 1;
        input.logger.debug(input.debug, `deterministic repair ${indexPath}`, nextIndexContent);
      }
    }

    for (const [filePath, content] of filesMap.entries()) {
      if (!isBrowserRuntimeFrontendFile({ path: filePath, content })) {
        continue;
      }

      const nextContent = repairFrontendRouterV6Usage(content);
      if (nextContent && nextContent !== content) {
        filesMap.set(filePath, nextContent);
        await writeGeneratedFile(input.outDir, {
          path: filePath,
          content: nextContent
        });
        appliedFixes += 1;
        input.logger.debug(input.debug, `deterministic repair ${filePath}`, nextContent);
      }
    }
  }

  if (input.targets.includes("backend")) {
    const appPy = filesMap.get("backend/app.py") ?? "";
    const requirementsPath = "backend/requirements.txt";
    const requirementsContent = filesMap.get(requirementsPath);
    if (requirementsContent && /CORS\s*\(/.test(appPy) && !/Flask-Cors/i.test(requirementsContent)) {
      const nextRequirements = `${requirementsContent.replace(/\s+$/, "")}\nFlask-Cors\n`;
      filesMap.set(requirementsPath, nextRequirements);
      await writeGeneratedFile(input.outDir, {
        path: requirementsPath,
        content: nextRequirements
      });
      appliedFixes += 1;
      input.logger.debug(
        input.debug,
        "deterministic repair backend/requirements.txt",
        nextRequirements
      );
    }
  }

  return {
    files: Array.from(filesMap.entries()).map(([filePath, content]) => ({
      path: filePath,
      content
    })),
    appliedFixes
  };
}

async function runAiStaticReviewAndRepair(input: {
  client: OpenAIClient;
  config: ResolvedCompileConfig;
  logger: ReturnType<typeof createLogger>;
  targets: CompileTarget[];
  specContext: string;
  compilePlan: string;
  files: GeneratedFile[];
  outDir: string;
  initialValidationErrors: string[];
  managedScaffoldPaths: Set<string>;
}): Promise<RepairPassResult> {
  let currentFiles = input.files;
  let appliedFixes = 0;
  let transcript = "";
  const failureReasons: string[] = [];

  for (let pass = 1; pass <= 3; pass += 1) {
    input.logger.step("review", `AI static review pass ${pass}`);
    const messages = buildStaticReviewMessages({
      specContext: input.specContext,
      compilePlan: input.compilePlan,
      targets: input.targets,
      files: currentFiles,
      initialValidationErrors: pass === 1 ? input.initialValidationErrors : []
    });

    let response = "";
    await input.client.streamChatCompletion(
      {
        model: input.config.model,
        temperature: 0,
        messages
      },
      chunk => {
        response += chunk;
      }
    );
    transcript += `\n\n=== pass ${pass} ===\n${response}`;
    input.logger.debug(
      input.config.compile.debug,
      `static review pass ${pass} raw response`,
      truncateForDebug(response)
    );

    const normalizedResponse = response.trim();

    if (normalizedResponse === "OK") {
      const validation = validateGeneratedArtifacts(
        currentFiles,
        input.targets,
        input.specContext
      );
      if (validation.errors.length > 0) {
        failureReasons.push(
          `AI review pass ${pass} returned OK but validation still failed: ${validation.errors.join("; ")}`
        );
        if (pass < 3) {
          input.logger.warn(
            `Static validation still failed after pass ${pass}. Retrying AI repair (${pass + 1}/3).`
          );
        }
        continue;
      }

      return {
        files: currentFiles,
        appliedFixes,
        transcript: transcript.trim(),
        success: true,
        failureReasons
      };
    }

    const repairedFiles = parseGeneratedFilesFromResponse(response);
    input.logger.debug(
      input.config.compile.debug,
      `static review pass ${pass} parsed files`,
      JSON.stringify(repairedFiles.map(file => file.path), null, 2)
    );
    if (repairedFiles.length === 0) {
      failureReasons.push(
        `AI review pass ${pass} returned neither OK nor parsable FILE blocks for repairs`
      );
      if (pass < 3) {
        input.logger.warn(`Static review pass ${pass} produced no usable repair. Retrying (${pass + 1}/3).`);
      }
      continue;
    }

    const filesMap = new Map(currentFiles.map(file => [file.path, file.content]));
    for (const repairedFile of repairedFiles) {
      if (input.managedScaffoldPaths.has(repairedFile.path)) {
        continue;
      }
      filesMap.set(repairedFile.path, repairedFile.content);
      await writeGeneratedFile(input.outDir, repairedFile);
    }

    currentFiles = Array.from(filesMap.entries()).map(([filePath, content]) => ({
      path: filePath,
      content
    }));
    appliedFixes += repairedFiles.length;

    const validation = validateGeneratedArtifacts(
      currentFiles,
      input.targets,
      input.specContext
    );
    if (validation.errors.length === 0) {
      return {
        files: currentFiles,
        appliedFixes,
        transcript: transcript.trim(),
        success: true,
        failureReasons
      };
    }

    failureReasons.push(
      `Validation errors after AI review pass ${pass}: ${validation.errors.join("; ")}`
    );
    if (pass < 3) {
      input.logger.warn(
        `Static validation still failed after pass ${pass}. Retrying AI repair (${pass + 1}/3).`
      );
    }
  }

  return {
    files: currentFiles,
    appliedFixes,
    transcript: transcript.trim(),
    success: false,
    failureReasons: Array.from(new Set(failureReasons))
  };
}

async function runAiRuntimeReviewAndRepair(input: {
  client: OpenAIClient;
  config: ResolvedCompileConfig;
  logger: ReturnType<typeof createLogger>;
  targets: CompileTarget[];
  specContext: string;
  compilePlan: string;
  files: GeneratedFile[];
  outDir: string;
}): Promise<RepairPassResult> {
  let currentFiles = input.files;
  let appliedFixes = 0;
  let transcript = "";
  const failureReasons: string[] = [];

  for (let pass = 1; pass <= 3; pass += 1) {
    input.logger.step("runtime", `Runtime validation pass ${pass}`);
    const runtimeValidation = await runRuntimeValidation({
      outDir: input.outDir,
      targets: input.targets,
      logger: input.logger,
      debug: input.config.compile.debug
    });

    if (runtimeValidation.success) {
      return {
        files: currentFiles,
        appliedFixes,
        transcript: transcript.trim(),
        success: true,
        failureReasons
      };
    }

    const formattedFailures = formatRuntimeFailures(runtimeValidation.failures);
    failureReasons.push(
      ...runtimeValidation.failures.map(
        failure => `${failure.target} ${failure.stage}: ${failure.summary}`
      )
    );

    const messages = buildRuntimeReviewMessages({
      specContext: input.specContext,
      compilePlan: input.compilePlan,
      targets: input.targets,
      files: currentFiles,
      runtimeFailures: runtimeValidation.failures
    });

    let response = "";
    await input.client.streamChatCompletion(
      {
        model: input.config.model,
        temperature: 0,
        messages
      },
      chunk => {
        response += chunk;
      }
    );
    transcript += `\n\n=== runtime pass ${pass} ===\n${formattedFailures}\n\n${response}`;
    input.logger.debug(
      input.config.compile.debug,
      `runtime review pass ${pass} raw response`,
      truncateForDebug(response)
    );

    const repairedFiles = parseGeneratedFilesFromResponse(response);
    input.logger.debug(
      input.config.compile.debug,
      `runtime review pass ${pass} parsed files`,
      JSON.stringify(repairedFiles.map(file => file.path), null, 2)
    );

    if (repairedFiles.length === 0) {
      failureReasons.push(
        `AI runtime review pass ${pass} returned no parsable FILE blocks for repair`
      );
      continue;
    }

    const filesMap = new Map(currentFiles.map(file => [file.path, file.content]));
    for (const repairedFile of repairedFiles) {
      filesMap.set(repairedFile.path, repairedFile.content);
      await writeGeneratedFile(input.outDir, repairedFile);
    }

    currentFiles = Array.from(filesMap.entries()).map(([filePath, content]) => ({
      path: filePath,
      content
    }));
    appliedFixes += repairedFiles.length;
  }

  const finalRuntimeValidation = await runRuntimeValidation({
    outDir: input.outDir,
    targets: input.targets,
    logger: input.logger,
    debug: input.config.compile.debug
  });
  if (finalRuntimeValidation.success) {
    return {
      files: currentFiles,
      appliedFixes,
      transcript: transcript.trim(),
      success: true,
      failureReasons
    };
  }

  failureReasons.push(
    ...finalRuntimeValidation.failures.map(
      failure => `${failure.target} ${failure.stage}: ${failure.summary}`
    )
  );

  return {
    files: currentFiles,
    appliedFixes,
    transcript: transcript.trim(),
    success: false,
    failureReasons: Array.from(new Set(failureReasons))
  };
}

function buildStaticReviewMessages(input: {
  specContext: string;
  compilePlan: string;
  targets: CompileTarget[];
  files: GeneratedFile[];
  initialValidationErrors: string[];
}) {
  return [
    {
      role: "system" as const,
      content:
        "You are the SpecOS static review and repair agent. Perform a static code review of the generated project against the spec and the generated stack. Focus on executable code that would fail to install, start, build, route, import, or integrate correctly. Also catch frontend/backend contract mismatches, missing dependencies, wrong entrypoints, broken routing defaults, API base URL mistakes, and violations of the spec. Root-level shared configuration templates and setup docs such as .env.example, README.md, and deployment notes are not local static validation targets unless they clearly contradict the executable code or spec. You must always return one of exactly two outcomes: 1. return exactly OK when the project fully passes static review, or 2. return only full replacement FILE blocks for every file that must change. Do not return an empty response. Do not include prose, markdown lists, JSON, or explanations."
    },
    {
      role: "user" as const,
      content: `Statically review this generated project and repair any incorrect files.

Targets:
${input.targets.join(", ")}

Compile plan:
${input.compilePlan.trim() || "(empty plan output)"}

Rules:
- The spec is the source of truth.
- Fix only files that are actually wrong.
- Keep the project runnable after dependency installation.
- Keep package manifests aligned with imported third-party modules.
- If a required package is missing, update the appropriate package manifest automatically as part of the repair.
- Do not modify compiler-managed scaffold files such as frontend/package.json, frontend/index.html, frontend/tsconfig.json, frontend/vite.config.ts, frontend/src/vite-env.d.ts, backend/requirements.txt, or root .env.example.
- Preserve the FILE + fenced code block protocol when returning fixes.
- If all checks pass, return exactly OK and nothing else.
- If checks fail, return only replacement FILE blocks for the files to fix and nothing else.
- Never return an empty response.
- Do not wrap \`FILE:\` lines inside an outer markdown code fence such as \`\`\`FILE: path.

Known validation errors from the compiler:
${input.initialValidationErrors.length > 0 ? input.initialValidationErrors.map(error => `- ${error}`).join("\n") : "- none"}

Spec project:
${input.specContext}

Generated files:
${serializeGeneratedFiles(input.files)}`
    }
  ];
}

function buildRuntimeReviewMessages(input: {
  specContext: string;
  compilePlan: string;
  targets: CompileTarget[];
  files: GeneratedFile[];
  runtimeFailures: RuntimeFailure[];
}) {
  return [
    {
      role: "system" as const,
      content:
        "You are the SpecOS runtime repair agent. Real runtime execution has already been attempted for the generated project. Fix only the files required to resolve the reported install, build, startup, import, routing, or runtime integration failures. The spec remains the source of truth. You must return only full replacement FILE blocks for every file you change. Do not return prose, markdown lists, JSON, explanations, or OK."
    },
    {
      role: "user" as const,
      content: `Repair this generated project using the runtime diagnostics below.

Targets:
${input.targets.join(", ")}

Compile plan:
${input.compilePlan.trim() || "(empty plan output)"}

Runtime repair rules:
- The spec is authoritative.
- Fix the actual cause shown by the runtime diagnostics.
- Keep the project runnable after dependency installation.
- You may modify generated files and runtime scaffold files such as frontend/package.json, frontend/vite.config.ts, frontend/tsconfig.json, frontend/index.html, and backend/requirements.txt when they are directly involved in the failure.
- Do not modify root .env.example unless the runtime diagnostics explicitly require it.
- Return only replacement FILE blocks for the files to change.
- Do not return explanations.
- Do not wrap \`FILE:\` lines inside an outer markdown code fence.

Runtime diagnostics:
${formatRuntimeFailures(input.runtimeFailures)}

Spec project:
${input.specContext}

Generated files:
${serializeGeneratedFiles(input.files)}`
    }
  ];
}

function formatRuntimeFailures(failures: RuntimeFailure[]): string {
  return failures
    .map(failure => {
      const output = truncateForDebug(failure.output.trim() || "(no output)", 2500);
      return [
        `- target: ${failure.target}`,
        `  stage: ${failure.stage}`,
        `  command: ${failure.command}`,
        `  summary: ${failure.summary}`,
        "  output:",
        indentMultilineBlock(output, "    ")
      ].join("\n");
    })
    .join("\n\n");
}

function indentMultilineBlock(value: string, prefix: string): string {
  return value
    .split("\n")
    .map(line => `${prefix}${line}`)
    .join("\n");
}

function repairFrontendPackageManifest(
  packageJsonContent: string,
  frontendFiles: GeneratedFile[]
): string | undefined {
  try {
    const manifest = JSON.parse(packageJsonContent) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    const dependencies = { ...(manifest.dependencies ?? {}) };
    const devDependencies = { ...(manifest.devDependencies ?? {}) };
    const declaredPackages = new Set([
      ...Object.keys(dependencies),
      ...Object.keys(devDependencies)
    ]);
    const importedPackages = collectImportedNodePackages(frontendFiles);
    let changed = false;

    for (const pkg of importedPackages) {
      if (declaredPackages.has(pkg)) {
        continue;
      }

      const target = shouldUseDevDependency(pkg) ? devDependencies : dependencies;
      target[pkg] = inferNodePackageVersion(pkg);
      declaredPackages.add(pkg);
      changed = true;
    }

    if (!changed) {
      return undefined;
    }

    manifest.dependencies = sortRecordKeys(dependencies);
    manifest.devDependencies = sortRecordKeys(devDependencies);
    return `${JSON.stringify(manifest, null, 2)}\n`;
  } catch {
    return undefined;
  }
}

function repairFrontendEntryFile(content: string): string | undefined {
  let next = content;
  let changed = false;

  if (/from\s+['"]react-dom['"]/.test(next)) {
    next = next.replace(
      /import\s+ReactDOM\s+from\s+['"]react-dom['"];?\n?/,
      "import { createRoot } from 'react-dom/client';\n"
    );
    changed = true;
  }

  if (/['"]antd\/dist\/antd\.css['"]/.test(next)) {
    next = next.replace(/['"]antd\/dist\/antd\.css['"]/g, "'antd/dist/reset.css'");
    changed = true;
  }

  if (/ReactDOM\.render\s*\(/.test(next)) {
    next = next.replace(
      /ReactDOM\.render\s*\(\s*([\s\S]*?)\s*,\s*document\.getElementById\(['"]root['"]\)\s*\);?/m,
      [
        "const container = document.getElementById('root');",
        "",
        "if (!container) {",
        "  throw new Error('Root container not found');",
        "}",
        "",
        "createRoot(container).render($1);"
      ].join("\n")
    );
    changed = true;
  }

  return changed ? `${next.replace(/\s+$/, "")}\n` : undefined;
}

function repairFrontendRouterV6Usage(content: string): string | undefined {
  let next = content;
  let changed = false;

  if (/\bRedirect\b/.test(next)) {
    next = next.replace(/\bRedirect\b/g, "Navigate");
    changed = true;
  }

  if (/\bSwitch\b/.test(next)) {
    next = next.replace(/\bSwitch\b/g, "Routes");
    changed = true;
  }

  if (/<Navigate([^>]*?)\s+from=(["'])[^"']+\2([^>]*?)\/>/.test(next)) {
    next = next.replace(/<Navigate([^>]*?)\s+from=(["'])[^"']+\2([^>]*?)\/>/g, "<Navigate$1$3 />");
    changed = true;
  }

  if (/<Navigate([^>]*?)\s+to=(["'])([^"']+)\2([^>]*?)\/>/.test(next) && !/\breplace=/.test(next)) {
    next = next.replace(
      /<Navigate([^>]*?)\s+to=(["'])([^"']+)\2([^>]*?)\/>/g,
      "<Navigate$1 to=$2$3$2 replace$4 />"
    );
    changed = true;
  }

  if (/import\s*\{\s*([^}]*?)\s*\}\s*from\s*['"]react-router-dom['"]/.test(next)) {
    next = next.replace(
      /import\s*\{\s*([^}]*?)\s*\}\s*from\s*['"]react-router-dom['"]/g,
      (_, imports: string) => {
        const normalized = imports
          .split(",")
          .map(part => part.trim())
          .filter(Boolean)
          .map(part => (part === "Redirect" ? "Navigate" : part === "Switch" ? "Routes" : part));
        return `import { ${Array.from(new Set(normalized)).join(", ")} } from 'react-router-dom'`;
      }
    );
    changed = true;
  }

  return changed ? `${next.replace(/\s+$/, "")}\n` : undefined;
}

function serializeGeneratedFiles(files: GeneratedFile[]): string {
  return files
    .map(file => {
      const language = detectFenceLanguage(file.path);
      return `FILE: ${file.path}\n\`\`\`${language}\n${file.content.replace(/\s+$/, "")}\n\`\`\``;
    })
    .join("\n\n");
}

function detectFenceLanguage(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".ts":
      return "ts";
    case ".tsx":
      return "tsx";
    case ".js":
      return "js";
    case ".jsx":
      return "jsx";
    case ".json":
      return "json";
    case ".py":
      return "py";
    case ".html":
      return "html";
    case ".css":
      return "css";
    default:
      return "";
  }
}

function parseGeneratedFilesFromResponse(response: string): GeneratedFile[] {
  const standardFiles = parseStandardGeneratedFilesFromResponse(response);
  if (standardFiles.length > 0) {
    return standardFiles;
  }

  return parseWrappedFenceGeneratedFilesFromResponse(response);
}

function parseStandardGeneratedFilesFromResponse(response: string): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  let buffer = response;

  while (true) {
    const match = matchNextCompletedFileBlock(buffer);
    if (!match) {
      break;
    }

    files.push(normalizeGeneratedFile(match.path, match.content));
    buffer = buffer.slice(match.endIndex);
  }

  return files;
}

function parseWrappedFenceGeneratedFilesFromResponse(response: string): GeneratedFile[] {
  const normalized = response.replace(/\r\n/g, "\n");
  const files: GeneratedFile[] = [];
  const pattern = /```FILE:\s*([^\n]+)\n([\s\S]*?)\n```/g;

  for (const match of normalized.matchAll(pattern)) {
    const filePath = match[1]?.trim();
    const content = match[2] ?? "";
    if (!filePath) {
      continue;
    }

    files.push(normalizeGeneratedFile(filePath, content));
  }

  return files;
}

function truncateForDebug(value: string, maxLength = 4000): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n...<truncated>`;
}

function validateGeneratedArtifacts(
  files: GeneratedFile[],
  targets: CompileTarget[],
  specContext: string
): { errors: string[]; warnings: string[] } {
  const parsedSpec = parseSpecProject(specContext);
  const fileSet = new Set(files.map(file => file.path));
  const fileMap = new Map(files.map(file => [file.path, file.content]));
  const frontendFiles = files.filter(file => file.path.startsWith("frontend/"));
  const backendFiles = files.filter(file => file.path.startsWith("backend/"));
  const frontendContent = frontendFiles.map(file => file.content).join("\n");
  const backendContent = backendFiles.map(file => file.content).join("\n");
  const errors: string[] = [];
  const warnings: string[] = [];

  if (targets.includes("frontend")) {
    const requiredFrontendGroups = [
      ["frontend/package.json"],
      ["frontend/index.html"],
      ["frontend/src/App.tsx", "frontend/src/App.jsx"],
      ["frontend/src/index.tsx", "frontend/src/index.jsx"]
    ];

    for (const group of requiredFrontendGroups) {
      if (!group.some(candidate => fileSet.has(candidate))) {
        errors.push(`frontend is missing required file: ${group.join(" or ")}`);
      }
    }

    if (!fileSet.has("frontend/tsconfig.json")) {
      warnings.push("frontend did not include tsconfig.json");
    }

    const packageJson = fileMap.get("frontend/package.json") ?? "";
    const usesVite = /"vite"\s*:/.test(packageJson);
    if (usesVite && !fileSet.has("frontend/vite.config.ts") && !fileSet.has("frontend/vite.config.js")) {
      warnings.push("frontend uses Vite but did not include vite.config.ts or vite.config.js");
    }

    const declaredPackages = collectDeclaredNodePackages(packageJson);
    const importedPackages = collectImportedNodePackages(
      frontendFiles
    );
    for (const pkg of importedPackages) {
      if (!declaredPackages.has(pkg)) {
        errors.push(`frontend imports "${pkg}" but frontend/package.json does not declare it`);
      }
    }

    for (const file of files.filter(isBrowserRuntimeFrontendFile)) {
      if (/https?:\/\/localhost:\d+/i.test(file.content)) {
        errors.push(`frontend hardcodes a localhost URL in ${file.path}; use relative /api paths instead`);
      }

      if (/\bRedirect\b/.test(file.content)) {
        errors.push(
          `frontend uses react-router-dom Redirect in ${file.path}; use Navigate for react-router-dom v6`
        );
      }

      if (/\bSwitch\b/.test(file.content)) {
        errors.push(
          `frontend uses react-router-dom Switch in ${file.path}; use Routes for react-router-dom v6`
        );
      }

      if (/['"`]antd\/dist\/antd\.css['"`]/.test(file.content)) {
        errors.push(`frontend imports removed Ant Design stylesheet path in ${file.path}; use antd/dist/reset.css or component styles compatible with antd v5`);
      }

      if (/ReactDOM\.render\s*\(/.test(file.content)) {
        warnings.push(`frontend uses legacy ReactDOM.render in ${file.path}; prefer react-dom/client createRoot for React 18`);
      }
    }

    const appContent = fileMap.get("frontend/src/App.tsx") ?? fileMap.get("frontend/src/App.jsx") ?? "";
    const specPageRoutes = parsedSpec.pages.map(page => page.route);
    if (specPageRoutes.length > 0 && !/path\s*=\s*["']\/["']/.test(appContent)) {
      warnings.push("frontend App is missing an explicit root route even though the spec defines page paths");
    }

    for (const page of parsedSpec.pages) {
      const pageContent = findFrontendModuleContent(frontendFiles, page.name) ?? frontendContent;

      if (!containsQuotedLiteral(frontendContent, page.route)) {
        errors.push(`spec route ${page.route} is missing from generated frontend code`);
      }

      for (const text of page.texts) {
        if (!containsTextEvidence(pageContent, text)) {
          errors.push(`spec page text "${text}" from page ${page.name} is missing from generated frontend code`);
        }
      }

      for (const layout of page.layouts) {
        if (!containsLayoutEvidence(pageContent, layout)) {
          errors.push(`spec layout ${layout} from page ${page.name} is missing or changed in generated frontend code`);
        }
      }

      for (const control of page.controls) {
        if (!containsControlEvidence(pageContent, control.kind)) {
          errors.push(
            `spec frontend control ${control.kind}${control.name ? `(${control.name})` : ""} from page ${page.name} is missing from generated frontend code`
          );
        }
      }

      for (const button of page.buttons) {
        if (!containsTextEvidence(pageContent, button)) {
          errors.push(`spec button "${button}" from page ${page.name} is missing from generated frontend code`);
        }
      }

      for (const flow of page.buttonFlows) {
        if (flow.dispatchAction && !containsActionUsage(pageContent, flow.dispatchAction)) {
          errors.push(
            `spec button "${flow.label}" on page ${page.name} does not appear to dispatch ${flow.dispatchAction} in generated frontend code`
          );
        }

        if (
          flow.refreshState &&
          !containsRefreshEvidence(pageContent, flow.refreshState, flow.dispatchAction)
        ) {
          errors.push(
            `spec button "${flow.label}" on page ${page.name} does not appear to refresh ${flow.refreshState} in generated frontend code`
          );
        }

        if (flow.openModal && !containsModalOpenEvidence(pageContent, flow.openModal)) {
          errors.push(
            `spec button "${flow.label}" on page ${page.name} does not appear to open modal ${flow.openModal} in generated frontend code`
          );
        }
      }
    }

    for (const state of parsedSpec.states) {
      if (!containsIdentifier(frontendContent, state.name)) {
        errors.push(`spec state ${state.name} is missing from generated frontend code`);
      }

      if (state.source && !containsIdentifier(frontendContent, state.source)) {
        errors.push(
          `spec state source ${state.source} for state ${state.name} is missing from generated frontend code`
        );
      }
    }

    for (const component of parsedSpec.components) {
      const componentContent = findFrontendModuleContent(frontendFiles, component.name) ?? frontendContent;

      if (!containsIdentifier(frontendContent, component.name)) {
        errors.push(`spec component ${component.name} is missing from generated frontend code`);
      }

      for (const field of component.formFields) {
        if (!containsIdentifier(componentContent, field)) {
          errors.push(
            `spec form field ${field} from component ${component.name} is missing from generated frontend code`
          );
        }
      }

      for (const modalTitle of component.modalTitles) {
        if (!containsTextEvidence(componentContent, modalTitle)) {
          errors.push(
            `spec modal title "${modalTitle}" from component ${component.name} is missing from generated frontend code`
          );
        }
      }

      for (const button of component.buttons) {
        if (!containsTextEvidence(componentContent, button)) {
          errors.push(`spec button "${button}" from component ${component.name} is missing from generated frontend code`);
        }
      }

      for (const formControl of component.formControls) {
        if (!containsFormControlEvidence(componentContent, formControl.control)) {
          errors.push(
            `spec form control ${formControl.control} for field ${formControl.name} in component ${component.name} is missing or changed in generated frontend code`
          );
        }
      }

      if (component.submitFlow?.dispatchAction && !containsActionUsage(componentContent, component.submitFlow.dispatchAction)) {
        errors.push(
          `spec component ${component.name} onSubmit does not appear to dispatch ${component.submitFlow.dispatchAction} in generated frontend code`
        );
      }

      if (
        component.submitFlow?.refreshState &&
        !containsRefreshEvidence(
          componentContent,
          component.submitFlow.refreshState,
          component.submitFlow.dispatchAction
        )
      ) {
        errors.push(
          `spec component ${component.name} onSubmit does not appear to refresh ${component.submitFlow.refreshState} in generated frontend code`
        );
      }

      if (component.submitFlow?.closeModal && !containsCloseModalEvidence(componentContent)) {
        errors.push(`spec component ${component.name} onSubmit does not appear to close the modal in generated frontend code`);
      }
    }

    for (const page of parsedSpec.pages) {
      for (const table of page.tables) {
        if (!containsIdentifier(frontendContent, table.stateName)) {
          errors.push(
            `spec table state ${table.stateName} from page ${page.name} is missing from generated frontend code`
          );
        }

        for (const column of table.columns) {
          if (!containsTableColumnEvidence(frontendContent, column)) {
            errors.push(
              `spec table column ${column} from page ${page.name} is missing from generated frontend code`
            );
          }
        }
      }
    }

    for (const action of parsedSpec.actions) {
      if (action.apiPath && !containsQuotedLiteral(frontendContent, action.apiPath)) {
        warnings.push(`spec API path ${action.apiPath} for action ${action.name} is not referenced in frontend code`);
      }
    }

    const usesApiPaths = files.some(
      file => file.path.startsWith("frontend/") && /['"`]\/api(?:\/|['"`])/.test(file.content)
    );
    const viteConfig =
      fileMap.get("frontend/vite.config.ts") ??
      fileMap.get("frontend/vite.config.js") ??
      "";
    if (usesApiPaths && viteConfig.length > 0 && !/proxy\s*:\s*\{[\s\S]*\/api/.test(viteConfig)) {
      warnings.push("frontend uses /api paths but vite.config does not appear to proxy /api for local development");
    }
  }

  if (targets.includes("backend")) {
    const requiredBackendGroups = [
      ["backend/app.py"],
      ["backend/requirements.txt"]
    ];

    for (const group of requiredBackendGroups) {
      if (!group.some(candidate => fileSet.has(candidate))) {
        errors.push(`backend is missing required file: ${group.join(" or ")}`);
      }
    }

    const backendApp = fileMap.get("backend/app.py") ?? "";
    const requirements = fileMap.get("backend/requirements.txt") ?? "";
    if (/CORS\s*\(/.test(backendApp) && !/Flask-Cors/i.test(requirements)) {
      errors.push("backend uses CORS but requirements.txt does not include Flask-Cors");
    }

    const frontendUsesApiPaths = files.some(
      file => file.path.startsWith("frontend/") && /['"`]\/api(?:\/|['"`])/.test(file.content)
    );
    if (targets.includes("frontend") && frontendUsesApiPaths) {
      if (!/url_prefix\s*=\s*["']\/api["']/.test(backendApp)) {
        warnings.push("frontend calls /api paths but backend/app.py does not appear to register routes under /api");
      }
      if (!/CORS\s*\(/.test(backendApp)) {
        warnings.push("backend does not appear to enable CORS for local development");
      }
    }

    if (!files.some(file => isRootLevelEnvTemplate(file.path))) {
      warnings.push(
        "generated project did not include a root-level environment template such as .env.example"
      );
    }

    for (const action of parsedSpec.actions) {
      if (action.apiPath && !containsQuotedLiteral(backendContent, action.apiPath)) {
        errors.push(`spec API path ${action.apiPath} for action ${action.name} is missing from generated backend code`);
      }

      for (const field of action.inputFields) {
        if (!containsIdentifier(backendContent, field)) {
          errors.push(`spec action input ${field} for action ${action.name} is missing from generated backend code`);
        }
      }

      for (const field of action.returnFields) {
        if (!containsIdentifier(backendContent, field)) {
          warnings.push(`spec action return field ${field} for action ${action.name} is not obvious in backend code`);
        }
      }
    }

    for (const entity of parsedSpec.entities) {
      if (!containsIdentifier(backendContent, entity.name)) {
        warnings.push(`spec entity ${entity.name} is not obvious in generated backend code`);
      }

      for (const field of entity.fields) {
        if (!containsIdentifier(backendContent, field)) {
          errors.push(`spec entity field ${field} for entity ${entity.name} is missing from generated backend code`);
        }
      }
    }
  }

  return { errors, warnings };
}

function containsIdentifier(content: string, identifier: string): boolean {
  if (!identifier.trim()) {
    return false;
  }

  const pattern = new RegExp(`\\b${escapeRegExp(identifier)}\\b`);
  return pattern.test(content);
}

function containsQuotedLiteral(content: string, literal: string): boolean {
  if (!literal.trim()) {
    return false;
  }

  const pattern = new RegExp(`["'\`]${escapeRegExp(literal)}["'\`]`);
  return pattern.test(content);
}

function containsTextEvidence(content: string, text: string): boolean {
  if (!text.trim()) {
    return false;
  }

  if (containsQuotedLiteral(content, text)) {
    return true;
  }

  const escaped = escapeRegExp(text).replace(/\s+/g, "\\s+");
  const jsxPattern = new RegExp(`>\\s*${escaped}\\s*<`);
  return jsxPattern.test(content);
}

function containsTableColumnEvidence(content: string, column: string): boolean {
  if (containsIdentifier(content, column)) {
    return true;
  }

  if (containsQuotedLiteral(content, column)) {
    return true;
  }

  if (column.toLowerCase() === "action" && containsTextEvidence(content, "Action")) {
    return true;
  }

  return false;
}

function containsActionUsage(content: string, actionName: string): boolean {
  const base = stripVerbPrefix(actionName);
  const subject = stripPluralSuffix(base);
  const candidates = Array.from(
    new Set(
      [
        actionName,
        toCamelCase(actionName),
        toPascalCase(actionName),
        base,
        toCamelCase(base),
        toPascalCase(base),
        `${inferCrudAlias(actionName)}${toPascalCase(subject)}`,
        `${inferLookupAlias(actionName)}${toPascalCase(base)}`,
        `${inferLookupAlias(actionName)}${toPascalCase(subject)}`
      ].filter(Boolean)
    )
  );

  return candidates.some(candidate => containsIdentifier(content, candidate));
}

function containsRefreshEvidence(
  content: string,
  stateName: string,
  relatedActionName?: string
): boolean {
  const singularState = stripPluralSuffix(stateName);
  const candidates = [
    stateName,
    singularState,
    `set${toPascalCase(stateName)}`,
    `set${toPascalCase(singularState)}`,
    `fetch${toPascalCase(singularState)}`,
    `fetch${toPascalCase(stateName)}`,
    `load${toPascalCase(singularState)}`,
    `load${toPascalCase(stateName)}`,
    `refresh${toPascalCase(stateName)}`,
    `refresh${toPascalCase(singularState)}`,
    `search${toPascalCase(stateName)}`,
    `search${toPascalCase(singularState)}`
  ];

  if (relatedActionName) {
    const actionSubject = stripPluralSuffix(stripVerbPrefix(relatedActionName));
    candidates.push(
      relatedActionName,
      toCamelCase(relatedActionName),
      `${inferCrudAlias(relatedActionName)}${toPascalCase(actionSubject)}`,
      `${inferLookupAlias(relatedActionName)}${toPascalCase(actionSubject)}`
    );
  }

  return candidates.some(candidate => containsIdentifier(content, candidate));
}

function containsModalOpenEvidence(content: string, modalName: string): boolean {
  const candidates = [
    modalName,
    "setModalVisible",
    "openModal",
    "showModal",
    "visible",
    "open"
  ];

  return candidates.some(candidate => containsIdentifier(content, candidate));
}

function containsCloseModalEvidence(content: string): boolean {
  const candidates = ["closeModal", "onClose", "setModalVisible", "setOpen", "setVisible"];
  return candidates.some(candidate => containsIdentifier(content, candidate));
}

function findFrontendModuleContent(files: GeneratedFile[], moduleName: string): string | undefined {
  const candidates = files.filter(file =>
    new RegExp(`/${escapeRegExp(moduleName)}\\.(tsx|jsx|ts|js)$`).test(file.path)
  );
  return candidates[0]?.content;
}

function containsControlEvidence(content: string, kind: string): boolean {
  switch (kind) {
    case "input":
      return /\bInput\b/.test(content);
    case "button":
      return /\bButton\b/.test(content);
    case "table":
      return /\bTable\b/.test(content);
    default:
      return containsIdentifier(content, kind);
  }
}

function containsFormControlEvidence(content: string, control: string): boolean {
  switch (control) {
    case "input":
      return /\bInput\b/.test(content);
    case "input-number":
      return /\bInputNumber\b/.test(content);
    case "radio":
      return /\bRadio\b/.test(content);
    default:
      return containsIdentifier(content, control);
  }
}

function containsLayoutEvidence(content: string, layout: string): boolean {
  const normalized = layout.toLowerCase();
  if (normalized === "flex(space-between)") {
    return (
      (/display\s*:\s*["']?flex["']?/i.test(content) && /space-between/i.test(content)) ||
      (/flex/i.test(content) && /justify-between/i.test(content))
    );
  }

  return containsIdentifier(content, layout);
}

function isRootLevelEnvTemplate(filePath: string): boolean {
  return /^(?:\.env(?:\.[^.\/]+)?|README(?:\.[^.\/]+)?|docker-compose\.yml|docker-compose\.yaml)$/i.test(
    filePath
  );
}

function extractFilePathFromValidationError(error: string): string | undefined {
  const patterns = [
    /required file:\s*([^\s]+)/i,
    /in\s+([^\s]+)$/i,
    /in\s+([^\s;]+?)(?:;|$)/i
  ];

  for (const pattern of patterns) {
    const match = error.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return undefined;
}

function collectDeclaredNodePackages(packageJsonContent: string): Set<string> {
  if (!packageJsonContent.trim()) {
    return new Set();
  }

  try {
    const manifest = JSON.parse(packageJsonContent) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    return new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {})
    ]);
  } catch {
    return new Set();
  }
}

function collectImportedNodePackages(files: GeneratedFile[]): Set<string> {
  const packages = new Set<string>();

  for (const file of files) {
    for (const specifier of extractModuleSpecifiers(file.content)) {
      const packageName = normalizePackageSpecifier(specifier);
      if (packageName) {
        packages.add(packageName);
      }
    }
  }

  return packages;
}

function isBrowserRuntimeFrontendFile(file: GeneratedFile): boolean {
  if (!file.path.startsWith("frontend/")) {
    return false;
  }

  if (!/^frontend\/src\/.+\.(ts|tsx|js|jsx)$/.test(file.path)) {
    return false;
  }

  return true;
}

function extractModuleSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^"'`]+?\s+from\s+)?["'`]([^"'`]+)["'`]/g,
    /\bexport\s+[^"'`]+?\s+from\s+["'`]([^"'`]+)["'`]/g,
    /\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1]?.trim();
      if (specifier) {
        specifiers.push(specifier);
      }
    }
  }

  return specifiers;
}

function normalizePackageSpecifier(specifier: string): string | undefined {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("http://") ||
    specifier.startsWith("https://") ||
    specifier.startsWith("node:")
  ) {
    return undefined;
  }

  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return scope && name ? `${scope}/${name}` : undefined;
  }

  const [name] = specifier.split("/");
  return name || undefined;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatFailureReport(summary: string, reasons: string[]): string {
  if (reasons.length === 0) {
    return summary;
  }

  return [summary, "", ...reasons.map(reason => `- ${reason}`)].join("\n");
}

function toCamelCase(input: string): string {
  return input.length > 0 ? input[0].toLowerCase() + input.slice(1) : input;
}

function toPascalCase(input: string): string {
  return input.length > 0 ? input[0].toUpperCase() + input.slice(1) : input;
}

function stripVerbPrefix(input: string): string {
  return input.replace(/^(Create|Search|Delete|Update|Get|List)/, "");
}

function stripPluralSuffix(input: string): string {
  return input.endsWith("s") && input.length > 1 ? input.slice(0, -1) : input;
}

function inferCrudAlias(actionName: string): string {
  if (/^Create/i.test(actionName)) {
    return "add";
  }

  if (/^Delete/i.test(actionName)) {
    return "delete";
  }

  if (/^Update/i.test(actionName)) {
    return "update";
  }

  return toCamelCase(stripVerbPrefix(actionName));
}

function inferLookupAlias(actionName: string): string {
  if (/^(Search|Get|List)/i.test(actionName)) {
    return "search";
  }

  return toCamelCase(stripVerbPrefix(actionName));
}

function sortRecordKeys(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right))
  );
}
