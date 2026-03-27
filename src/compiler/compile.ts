import path from "node:path";
import { OpenAIClient } from "../ai/openai-client.js";
import { ResolvedCompileConfig } from "../config/types.js";
import { emitGeneratedProject } from "../emitter/project-emitter.js";
import { createLogger } from "../utils/logger.js";
import { loadSpecProject } from "../spec/loader.js";
import { ensureDirectory, writeJsonFile } from "../utils/fs.js";

export type GeneratedFile = {
  path: string;
  content: string;
};

export type CompileResult = {
  files: GeneratedFile[];
  warnings: string[];
};

type ModelFilePayload = {
  path: string;
  content: string;
};

type ModelCompilePayload = {
  summary?: string;
  warnings?: string[];
  files?: ModelFilePayload[];
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

  const client = new OpenAIClient({
    host: config.host,
    auth: config.auth,
    timeout: config.timeout
  });

  logger.step("3/5", "Requesting AI compile plan");
  logger.debug(
    config.compile.debug,
    "plan request",
    JSON.stringify(buildPlanMessages(project.promptContext, config), null, 2)
  );
  await client.streamChatCompletion(
    {
      model: config.model,
      temperature: config.ai.temperature,
      messages: buildPlanMessages(project.promptContext, config)
    },
    chunk => process.stdout.write(chunk)
  );
  process.stdout.write("\n");

  logger.step("4/5", "Generating project files");
  const generationMessages = buildGenerationMessages(project.promptContext, config);
  logger.debug(
    config.compile.debug,
    "generate request",
    JSON.stringify(generationMessages, null, 2)
  );

  let completionText = "";
  let repairedText: string | undefined;
  let payload: ModelCompilePayload;

  try {
    completionText = await client.createChatCompletion({
      model: config.model,
      temperature: config.ai.temperature,
      messages: generationMessages
    });

    logger.debug(config.compile.debug, "raw generate response", completionText);

    const parsed = await parseCompilePayloadWithRepair({
      raw: completionText,
      client,
      config,
      logger
    });
    payload = parsed.payload;
    repairedText = parsed.repairedText;

    if (repairedText) {
      logger.debug(config.compile.debug, "repaired generate response", repairedText);
    }
  } catch (error) {
    await writeDebugFailureArtifacts({
      outDir: config.outDir,
      planMessages: buildPlanMessages(project.promptContext, config),
      generationMessages,
      rawGenerateResponse: completionText,
      errorMessage: error instanceof Error ? error.message : String(error)
    });

    throw error;
  }

  const files = normalizeGeneratedFiles(payload.files ?? []);
  const allWarnings = [...warnings, ...(payload.warnings ?? [])];

  logger.step("5/5", `Writing generated files into ${config.outDir}`);
  await emitGeneratedProject({
    outDir: config.outDir,
    clean: config.compile.clean,
    files,
    metadata: {
      generatedAt: new Date().toISOString(),
      projectDir: config.projectDir,
      model: config.model,
      summary: payload.summary ?? "",
      warnings: allWarnings
    },
    promptTrace: {
      plan: buildPlanMessages(project.promptContext, config),
      generate: buildGenerationMessages(project.promptContext, config),
      rawGenerateResponse: completionText,
      repairedGenerateResponse: repairedText ?? null
    }
  });

  return {
    files,
    warnings: allWarnings
  };
}

async function parseCompilePayloadWithRepair(input: {
  raw: string;
  client: OpenAIClient;
  config: ResolvedCompileConfig;
  logger: ReturnType<typeof createLogger>;
}): Promise<{ payload: ModelCompilePayload; repairedText?: string }> {
  try {
    return { payload: parseCompilePayload(input.raw) };
  } catch (error) {
    input.logger.warn("Primary AI response was not valid JSON. Attempting one repair pass.");

    const repaired = await input.client.createChatCompletion({
      model: input.config.model,
      temperature: 0,
      messages: buildRepairMessages(input.raw)
    });

    try {
      return {
        payload: parseCompilePayload(repaired),
        repairedText: repaired
      };
    } catch {
      throw new Error(
        "AI compile response did not contain valid JSON. Check dist/.specos/prompt-trace.json for the raw model output."
      );
    }
  }
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

function buildGenerationMessages(specContext: string, config: ResolvedCompileConfig) {
  return [
    {
      role: "system" as const,
      content:
        "You are the SpecOS compile agent. Convert the provided spec project into a runnable application skeleton. Return JSON only. No markdown fences. No prose outside JSON."
    },
    {
      role: "user" as const,
      content: `Generate a project using:
- Frontend: ${config.stack.frontend}
- UI Library: ${config.stack.ui}
- Frontend Language: ${config.stack.language}
- Backend: ${config.stack.backend}
- Database: ${config.stack.database}

Return JSON with this exact shape:
{
  "summary": "short summary",
  "warnings": ["warning"],
  "files": [
    {
      "path": "frontend/package.json",
      "content": "file content"
    }
  ]
}

Rules:
- Include a minimal but coherent full-stack project.
- Use TypeScript in the frontend.
- Use Flask and pymongo in the backend.
- Keep files compact, but runnable after dependency installation.
- Include frontend and backend README files if useful.
- Ensure API routes and frontend API calls match the spec.
- Do not omit package manifests or dependency files.
- Paths must be relative, never absolute.

Spec project:
${specContext}`
    }
  ];
}

function buildRepairMessages(rawOutput: string) {
  return [
    {
      role: "system" as const,
      content:
        "You are a JSON repair agent. Convert the provided model output into valid JSON only. No markdown fences. No explanation."
    },
    {
      role: "user" as const,
      content: `Return JSON with this exact shape:
{
  "summary": "short summary",
  "warnings": ["warning"],
  "files": [
    {
      "path": "frontend/package.json",
      "content": "file content"
    }
  ]
}

If the input contains prose or markdown, extract the intended JSON payload and repair escaping issues.

Model output to repair:
${rawOutput}`
    }
  ];
}

function validateSpecFiles(files: string[]): string[] {
  const warnings: string[] = [];

  if (!files.some(file => path.basename(file) === "app.spec")) {
    warnings.push("No app.spec file found. Compile will still proceed using every .spec file.");
  }

  return warnings;
}

function parseCompilePayload(raw: string): ModelCompilePayload {
  const trimmed = raw.trim();
  const withoutCodeFence = trimmed.replace(/^```json\s*|^```\s*|```$/gm, "").trim();
  const jsonText = extractJsonObject(withoutCodeFence);

  return JSON.parse(jsonText) as ModelCompilePayload;
}

function extractJsonObject(input: string): string {
  const start = input.indexOf("{");
  const end = input.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("AI compile response did not contain a JSON object");
  }

  return input.slice(start, end + 1);
}

function normalizeGeneratedFiles(files: ModelFilePayload[]): GeneratedFile[] {
  const normalized = files
    .filter(file => typeof file.path === "string" && typeof file.content === "string")
    .map(file => normalizeGeneratedFile(file.path, file.content));

  if (normalized.length === 0) {
    throw new Error("AI compile response did not contain any files");
  }

  return normalized;
}

function normalizeGeneratedFile(filePath: string, content: string): GeneratedFile {
  const normalizedPath = filePath.replace(/^\/+/, "");

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
    content
  };
}

async function writeDebugFailureArtifacts(input: {
  outDir: string;
  planMessages: ReturnType<typeof buildPlanMessages>;
  generationMessages: ReturnType<typeof buildGenerationMessages>;
  rawGenerateResponse: string;
  errorMessage: string;
}): Promise<void> {
  const metaDir = path.join(input.outDir, ".specos");
  await ensureDirectory(metaDir);
  await writeJsonFile(path.join(metaDir, "prompt-trace.json"), {
    plan: input.planMessages,
    generate: input.generationMessages,
    rawGenerateResponse: input.rawGenerateResponse,
    error: input.errorMessage
  });
}
