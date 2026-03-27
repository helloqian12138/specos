import path from "node:path";
import fs from "node:fs/promises";
import { OpenAIClient } from "../ai/openai-client.js";
import { ResolvedCompileConfig } from "../config/types.js";
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

  logger.step(
    "4/5",
    `Generating project files with ${targets.join(" + ")} agent(s)${
      targets.length > 1 ? " in parallel" : ""
    }`
  );
  const transcripts: Partial<Record<CompileTarget, string>> = {};
  const promptTraceByTarget: Partial<Record<CompileTarget, ReturnType<typeof buildGenerationMessages>>> = {};
  const filesMap = new Map<string, string>();
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
        await consumeGenerationChunk(chunk, targetState, config, logger, target);
      }
    );

    process.stdout.write("\n");
    await flushCompletedFileBlocks(targetState, config, logger, target);
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

  logger.step("5/5", `Finalizing compile output in ${config.outDir}`);
  await emitGeneratedProject({
    outDir: config.outDir,
    clean: false,
    files,
    metadata: {
      generatedAt: new Date().toISOString(),
      projectDir: config.projectDir,
      model: config.model,
      summary: `Generated ${files.length} files from streamed code blocks.`,
      warnings
    },
    promptTrace: {
      plan: planMessages,
      compilePlan,
      targets,
      generateByTarget: promptTraceByTarget,
      generationTranscriptsByTarget: transcripts,
      protocol: getFileBlockProtocolDescription()
    }
  });

  return {
    files,
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
  target: CompileTarget
): Promise<void> {
  state.buffer += chunk;
  state.transcript += chunk;
  await flushCompletedFileBlocks(state, config, logger, target);
}

async function flushCompletedFileBlocks(
  state: StreamParseState,
  config: ResolvedCompileConfig,
  logger: ReturnType<typeof createLogger>,
  target: CompileTarget
): Promise<void> {
  while (true) {
    const match = matchNextCompletedFileBlock(state.buffer);
    if (!match) {
      break;
    }

    const generatedFile = normalizeGeneratedFile(match.path, match.content);
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
  const fileHeaderMatch = /FILE:\s*([^\n]+)\n```([a-zA-Z0-9._+-]*)?\n/.exec(input);
  if (!fileHeaderMatch || fileHeaderMatch.index === undefined) {
    return undefined;
  }

  const contentStart = fileHeaderMatch.index + fileHeaderMatch[0].length;
  const fenceEndIndex = input.indexOf("\n```", contentStart);
  if (fenceEndIndex === -1) {
    return undefined;
  }

  return {
    path: fileHeaderMatch[1].trim(),
    content: input.slice(contentStart, fenceEndIndex),
    endIndex: fenceEndIndex + "\n```".length
  };
}

function buildPlanMessages(specContext: string, config: ResolvedCompileConfig) {
  return [
    {
      role: "system" as const,
      content:
        "You are the SpecOS planning agent. Explain how you will compile the spec into a React + Ant Design + TypeScript frontend and a Python + Flask + MongoDB backend. Keep the response concise, operational, and step-based."
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

Explain the compile plan and major files you will create.`
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
        `You are the SpecOS ${target} compile agent. Generate executable project files, not JSON. Stream the answer as code blocks only. Each file must start with \`FILE: relative/path\` on its own line, followed immediately by a fenced code block. You may emit the same file path again later with a more complete version; the compiler will treat the latest block as the current file content.`
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
FILE: frontend/package.json
\`\`\`json
{
  "name": "frontend"
}
\`\`\`

FILE: frontend/src/App.tsx
\`\`\`tsx
export default function App() {
  return <div>Hello</div>;
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
- Include package/dependency files needed to install and run the project.
- Prefer complete file replacements if you revise a file later in the stream.

Spec project:
${specContext}`
    }
  ];
}

function getTargetInstructions(target: CompileTarget, config: ResolvedCompileConfig): string {
  if (target === "frontend") {
    return `Focus on React + ${config.stack.ui} + ${config.stack.language}. Emit files under frontend/ only. Implement pages, components, API client calls, and frontend package configuration. Do not emit backend files or shared files.`;
  }

  return `Focus on ${config.stack.backend} + ${config.stack.database}. Emit files under backend/ only. Implement Flask app setup, routes, models, services, dependency files, and backend run instructions. Do not emit frontend files or shared files.`;
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
