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
import { emitGeneratedProject } from "../emitter/project-emitter.js";
import { loadSpecProject } from "../spec/loader.js";
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

  logger.step("1/5", `Loading spec project from ${config.projectDir}`);
  const project = await loadSpecProject(config.projectDir, config.outDir);

  logger.step("2/5", "Validating spec files");
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
  logger.step("3/5", "Requesting AI compile plan");
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

  const managedScaffoldFiles = await loadManagedScaffoldFiles(config.projectDir, project.promptContext);
  const managedScaffoldPaths = new Set(listManagedScaffoldPaths());
  for (const scaffoldFile of managedScaffoldFiles) {
    await writeGeneratedFile(config.outDir, scaffoldFile);
  }

  logger.step(
    "4/5",
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
      target === "frontend" ? "4a/5" : "4b/5",
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

  logger.step("5/6", "Running AI static review and repair");
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
    await writeDebugFailureArtifacts({
      outDir: config.outDir,
      planMessages,
      compilePlan,
      generationMessagesByTarget: promptTraceByTarget,
      generationTranscriptsByTarget: transcripts,
      errorMessage: `Generated project failed after AI static review: ${uniqueFailureReasons.join("; ")}`
    });
    throw new Error(
      `Compile failed after 3 AI static review passes: ${uniqueFailureReasons.join("; ")}`
    );
  }

  logger.step("6/6", `Finalizing compile output in ${config.outDir}`);
  await emitGeneratedProject({
    outDir: config.outDir,
    clean: false,
    files: repairedFiles,
    metadata: {
      generatedAt: new Date().toISOString(),
      projectDir: config.projectDir,
      model: config.model,
      summary: `Generated ${repairedFiles.length} files from streamed code blocks.`,
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
      protocol: getFileBlockProtocolDescription()
    }
  });

  return {
    files: repairedFiles,
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
Frontend: ${config.stack.frontend}
UI: ${config.stack.ui}
Language: ${config.stack.language}
Backend: ${config.stack.backend}
Database: ${config.stack.database}

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
- Frontend: ${config.stack.frontend}
- UI Library: ${config.stack.ui}
- Frontend Language: ${config.stack.language}
- Backend: ${config.stack.backend}
- Database: ${config.stack.database}

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
    return `Focus on React + ${config.stack.ui} + ${config.stack.language}. Emit business-facing frontend files under frontend/, especially frontend/src/. Implement a complete runnable frontend app, not just isolated components. The compiler already provides frontend/package.json, frontend/index.html, frontend/tsconfig.json, frontend/vite.config.ts, frontend/src/vite-env.d.ts, backend/requirements.txt, and root .env.example; do not emit or replace those scaffold files. Also implement pages, components, API client calls, and route wiring. Environment requirements: target modern Node 18+ compatibility; assume a Vite + React + TypeScript scaffold already exists; do not switch toolchains. Networking requirements: do not hardcode absolute browser API URLs such as \`http://localhost:5000\` in frontend code; call backend APIs through same-origin relative paths such as \`/api\`. Routing requirements: if the spec defines one or more page paths such as \`/users\`, the generated app must still render successfully at \`/\`; add a default route that redirects or navigates from \`/\` to the primary page, and add a catch-all fallback route that redirects unknown paths to a valid page instead of rendering a 404. Spec compliance requirements: preserve each page path exactly as written in the spec, render the correct page content for that route, and ensure UI field names, validation rules, and actions match the spec. Do not emit backend runtime code files.`;
  }

  return `Focus on ${config.stack.backend} + ${config.stack.database}. Emit executable backend code under backend/, such as backend/app.py, route modules, services, and models. Do not emit environment scaffold files. The compiler already provides backend/requirements.txt and root .env.example; do not emit or replace them. Networking requirements: generated backend APIs should be compatible with a frontend dev server on http://localhost:3000; when appropriate, expose API routes under an /api prefix and include local-development CORS support such as Flask-Cors for http://localhost:3000 and http://127.0.0.1:3000 so browser requests are not blocked if the frontend is served separately. Spec compliance requirements: action inputs, storage fields, validation rules, and response payloads must match the spec and stay consistent with the frontend-facing API contract. Do not emit frontend runtime code files.`;
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
  const stackValue = target === "frontend" ? config.stack.frontend : config.stack.backend;
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
}): Promise<void> {
  const metaDir = path.join(input.outDir, ".specos");
  await ensureDirectory(metaDir);
  await writeJsonFile(path.join(metaDir, "prompt-trace.json"), {
    plan: input.planMessages,
    compilePlan: input.compilePlan,
    generateByTarget: input.generationMessagesByTarget,
    generationTranscriptsByTarget: input.generationTranscriptsByTarget,
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
  }

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
  const fileSet = new Set(files.map(file => file.path));
  const fileMap = new Map(files.map(file => [file.path, file.content]));
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
      files.filter(file => file.path.startsWith("frontend/"))
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
    }

    const appContent =
      fileMap.get("frontend/src/App.tsx") ??
      fileMap.get("frontend/src/App.jsx") ??
      "";
    const specPageRoutes = Array.from(specContext.matchAll(/Page\s+\w+\s*\((\/[^)\s]+)\)/g)).map(
      match => match[1]
    );
    if (specPageRoutes.length > 0 && !/path\s*=\s*["']\/["']/.test(appContent)) {
      warnings.push("frontend App is missing an explicit root route even though the spec defines page paths");
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
  }

  return { errors, warnings };
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

function sortRecordKeys(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right))
  );
}
