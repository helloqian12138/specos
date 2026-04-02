import path from "node:path";
import fs from "node:fs/promises";
import { ParsedArgs } from "../cli.js";
import { OpenAIClient } from "../ai/openai-client.js";
import { loadGlobalConfig } from "../config/global-config.js";
import { loadProjectConfig, resolveProjectStackConfig } from "../config/project-config.js";
import { StackConfig } from "../config/types.js";
import { readLatestProjectError } from "../debug/error-history.js";
import { ensureDirectory, fileExists, listFilesRecursively, readTextFile, writeTextFile } from "../utils/fs.js";
import { loadSpecProject } from "../spec/loader.js";

const ANSI = {
  reset: "\u001b[0m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m"
} as const;

export async function runFixCommand(parsed: ParsedArgs): Promise<void> {
  const useLatest = parsed.flags.latest === true || parsed.flags.lastest === true;
  const apply = parsed.flags.apply === true;
  const projectInput = resolveProjectInput(parsed, useLatest);
  const projectDir = await resolveProjectDir(projectInput);

  const globalConfig = await loadGlobalConfig();
  const projectConfig = await loadProjectConfig(projectDir);
  const resolvedStack = await resolveProjectStackConfig(projectDir, projectConfig);
  const host = stringFlag(parsed.flags.host) ?? globalConfig.host;
  const auth = stringFlag(parsed.flags.auth) ?? globalConfig.auth;

  if (!host || !auth) {
    throw new Error("missing API credentials. Run `spec init --host ... --auth ...` first, or pass --host and --auth.");
  }

  const outDir = path.resolve(
    projectDir,
    stringFlag(parsed.flags.outDir) ?? projectConfig.outDir ?? globalConfig.dist ?? "./dist"
  );

  const latestError = (!resolveErrorMessage(parsed) || useLatest)
    ? await readLatestProjectError(projectDir)
    : undefined;
  const errorMessage = resolveErrorMessage(parsed) ?? latestError?.error;
  if (!errorMessage) {
    throw new Error(
      "fix requires an error message, or use spec fix <projectDir> --latest after a failed compile/run"
    );
  }

  const client = new OpenAIClient({
    host,
    auth,
    timeout: numberFlag(parsed.flags.timeout) ?? globalConfig.timeout ?? 120000
  });

  const specProject = await loadSpecProject(projectDir, outDir);
  const projectContext = await buildProjectContext(projectDir, outDir, errorMessage);
  const promptInput = {
    projectDir,
    outDir,
    errorMessage,
    latestErrorContext: latestError
      ? `Latest stored error: ${latestError.error}\nRecorded at: ${latestError.timestamp}\nCommand: ${latestError.command}`
      : "No stored error metadata found.",
    stack: resolvedStack,
    model:
      stringFlag(parsed.flags.model) ??
      projectConfig.ai?.model ??
      globalConfig.model ??
      "gpt-4o-mini",
    specContext: specProject.promptContext,
    projectContext
  };
  const prompt = apply ? buildFixApplyPrompt(promptInput) : buildFixPrompt(promptInput);

  const response = await client.createChatCompletion({
    model:
      stringFlag(parsed.flags.model) ??
      projectConfig.ai?.model ??
      globalConfig.model ??
      "gpt-4o-mini",
    temperature: 0,
    messages: prompt
  });

  let appliedFiles: string[] = [];
  let applyModeResult: "applied" | "no_fix" | "failed" | undefined;
  if (apply) {
    const parsedFiles = parseGeneratedFilesFromResponse(response);
    if (parsedFiles.length === 0) {
      applyModeResult = response.trim() === "NO_FIX" ? "no_fix" : "failed";
    } else {
      appliedFiles = await applyFixFiles(outDir, parsedFiles);
      applyModeResult = appliedFiles.length > 0 ? "applied" : "failed";
    }
  }

  printFixReport({
    projectDir,
    outDir,
    errorMessage,
    usedLatestStoredError: Boolean(latestError) && !resolveErrorMessage(parsed),
    response: response.trim(),
    applyRequested: apply,
    applyModeResult,
    appliedFiles
  });
}

async function buildProjectContext(
  projectDir: string,
  outDir: string,
  errorMessage: string
): Promise<string> {
  const sections: string[] = [];
  sections.push(`Project directory: ${projectDir}`);
  sections.push(`Output directory: ${outDir}`);

  const compileLogPath = path.join(outDir, ".specos", "compile-log.json");
  if (await fileExists(compileLogPath)) {
    sections.push(`FILE: .specos/compile-log.json\n${await readLimitedFile(compileLogPath, 6000)}`);
  }

  const promptTracePath = path.join(outDir, ".specos", "prompt-trace.json");
  if (await fileExists(promptTracePath)) {
    sections.push(`FILE: .specos/prompt-trace.json\n${await readLimitedFile(promptTracePath, 12000)}`);
  }

  const relevantFiles = await collectRelevantFiles(projectDir, outDir, errorMessage);
  for (const filePath of relevantFiles) {
    const relative = path.relative(outDir, filePath);
    sections.push(`FILE: ${relative}\n${await readLimitedFile(filePath, 8000)}`);
  }

  return sections.join("\n\n---\n\n");
}

async function collectRelevantFiles(
  projectDir: string,
  outDir: string,
  errorMessage: string
): Promise<string[]> {
  const candidates = new Set<string>();
  const normalizedError = errorMessage.toLowerCase();

  const alwaysInclude = [
    path.join(outDir, "backend", "app.py"),
    path.join(outDir, "backend", "requirements.txt"),
    path.join(outDir, "frontend", "package.json"),
    path.join(outDir, "frontend", "src", "App.tsx"),
    path.join(outDir, "frontend", "src", "index.tsx")
  ];
  for (const candidate of alwaysInclude) {
    if (await fileExists(candidate)) {
      candidates.add(candidate);
    }
  }

  if (normalizedError.includes("backend")) {
    const backendDir = path.join(outDir, "backend");
    if (await fileExists(backendDir)) {
      const files = await listFilesRecursively(backendDir);
      for (const filePath of files.filter(isSourceLikeFile).slice(0, 12)) {
        candidates.add(filePath);
      }
    }
  }

  if (normalizedError.includes("frontend") || normalizedError.includes("vite") || normalizedError.includes("react")) {
    const frontendDir = path.join(outDir, "frontend", "src");
    if (await fileExists(frontendDir)) {
      const files = await listFilesRecursively(frontendDir);
      for (const filePath of files.filter(isSourceLikeFile).slice(0, 12)) {
        candidates.add(filePath);
      }
    }
  }

  if (candidates.size < 8) {
    const sharedDir = path.join(outDir, "shared");
    if (await fileExists(sharedDir)) {
      const files = await listFilesRecursively(sharedDir);
      for (const filePath of files.filter(isSourceLikeFile).slice(0, 4)) {
        candidates.add(filePath);
      }
    }
  }

  return Array.from(candidates);
}

function buildFixPrompt(input: {
  projectDir: string;
  outDir: string;
  errorMessage: string;
  latestErrorContext: string;
  stack: StackConfig;
  model: string;
  specContext: string;
  projectContext: string;
}) {
  return [
    {
      role: "system" as const,
      content:
        "You are the SpecOS debugging assistant. Diagnose compile failures and runtime errors for a spec-driven generated project. Be concrete, technical, and actionable. Identify the most likely root cause, explain whether the issue comes from the spec, the generated code, the runtime environment, or the compiler, and give a short ordered repair plan. When the evidence is insufficient, say what is missing."
    },
    {
      role: "user" as const,
      content: `Help debug this SpecOS project failure.

Project:
- Directory: ${input.projectDir}
- Output: ${input.outDir}
- Frontend: ${input.stack.frontend.framework} ${input.stack.frontend.frameworkVersion ?? ""}
- UI: ${input.stack.frontend.ui} ${input.stack.frontend.uiVersion ?? ""}
- Frontend language: ${input.stack.frontend.language} ${input.stack.frontend.languageVersion ?? ""}
- Frontend dev server: http://${input.stack.frontend.host}:${input.stack.frontend.port}
- Backend: ${input.stack.backend.framework} ${input.stack.backend.frameworkVersion ?? ""}
- Backend language: ${input.stack.backend.language} ${input.stack.backend.languageVersion ?? ""}
- Backend runtime: http://${input.stack.backend.host}:${input.stack.backend.port}
- Database: ${input.stack.data.engine} ${input.stack.data.engineVersion ?? ""}
- Database URI: ${input.stack.data.uri}
- Model: ${input.model}

Reported error:
${input.errorMessage}

Stored error context:
${input.latestErrorContext}

Spec files:
${input.specContext}

Debug context:
${input.projectContext}

Output requirements:
- Start with a one-line diagnosis.
- Then provide exactly these sections with markdown headings:
  1. Root Cause
  2. Why It Happened
  3. What To Check
  4. Suggested Fix
  5. If This Is A Spec Problem
- In "What To Check", use flat bullets with concrete file paths when possible.
- In "Suggested Fix", give a short ordered list.
- If the issue likely came from generated code, say which generated file is the best first place to edit.
- If the issue likely came from the spec itself, quote the conflicting structure names briefly and explain the inconsistency.`
    }
  ];
}

function buildFixApplyPrompt(input: {
  projectDir: string;
  outDir: string;
  errorMessage: string;
  latestErrorContext: string;
  stack: StackConfig;
  model: string;
  specContext: string;
  projectContext: string;
}) {
  return [
    {
      role: "system" as const,
      content:
        "You are the SpecOS repair assistant. Repair the generated project for the reported failure. Return only full replacement FILE blocks for the files you change, or exactly NO_FIX if you cannot propose a safe concrete patch. Do not return prose or markdown outside FILE blocks."
    },
    {
      role: "user" as const,
      content: `Repair this SpecOS generated project.

Project:
- Directory: ${input.projectDir}
- Output: ${input.outDir}
- Frontend: ${input.stack.frontend.framework} ${input.stack.frontend.frameworkVersion ?? ""}
- UI: ${input.stack.frontend.ui} ${input.stack.frontend.uiVersion ?? ""}
- Frontend language: ${input.stack.frontend.language} ${input.stack.frontend.languageVersion ?? ""}
- Frontend dev server: http://${input.stack.frontend.host}:${input.stack.frontend.port}
- Backend: ${input.stack.backend.framework} ${input.stack.backend.frameworkVersion ?? ""}
- Backend language: ${input.stack.backend.language} ${input.stack.backend.languageVersion ?? ""}
- Backend runtime: http://${input.stack.backend.host}:${input.stack.backend.port}
- Database: ${input.stack.data.engine} ${input.stack.data.engineVersion ?? ""}
- Database URI: ${input.stack.data.uri}
- Model: ${input.model}

Reported error:
${input.errorMessage}

Stored error context:
${input.latestErrorContext}

Spec files:
${input.specContext}

Debug context:
${input.projectContext}

Repair rules:
- Modify only generated files inside frontend/, backend/, or shared/ under the output directory.
- Prefer the smallest safe patch that fixes the reported issue.
- Keep the spec authoritative.
- Return exactly NO_FIX if the issue is primarily caused by the spec or missing external infrastructure.

Output protocol:
FILE: frontend/src/App.tsx
\`\`\`tsx
export function App() {
  return <div>App</div>;
}
\`\`\``
    }
  ];
}

async function readLimitedFile(filePath: string, maxChars: number): Promise<string> {
  const content = await readTextFile(filePath);
  return content.length <= maxChars ? content : `${content.slice(0, maxChars)}\n...<truncated>`;
}

function resolveErrorMessage(parsed: ParsedArgs): string | undefined {
  const fromFlag = stringFlag(parsed.flags.error);
  if (fromFlag) {
    return fromFlag;
  }

  const remaining = parsed.positionals.slice(1).join(" ").trim();
  return remaining || undefined;
}

function resolveProjectInput(parsed: ParsedArgs, useLatest: boolean): string {
  const positional = parsed.positionals[0];
  if (typeof positional === "string") {
    return positional;
  }

  if (useLatest) {
    return ".";
  }

  throw new Error(
    "fix requires a project directory, for example: spec fix ./examples/users --error \"backend start failed\""
  );
}

async function resolveProjectDir(projectInput: string): Promise<string> {
  const projectDir = path.resolve(process.cwd(), projectInput);
  if (await fileExists(projectDir)) {
    return projectDir;
  }

  const suggestions = await findSuggestedProjectDirs(projectInput);
  if (suggestions.length > 0) {
    throw new Error(
      `project directory not found: ${projectDir}\n\nDid you mean:\n${suggestions.map(item => `- ${item}`).join("\n")}`
    );
  }

  throw new Error(`project directory not found: ${projectDir}`);
}

async function findSuggestedProjectDirs(projectInput: string): Promise<string[]> {
  const candidates = await collectProjectDirCandidates(process.cwd(), 4);
  const normalizedInput = normalizePathForCompare(path.resolve(process.cwd(), projectInput));

  return candidates
    .map(candidate => ({
      candidate,
      score: levenshtein(normalizedInput, normalizePathForCompare(candidate))
    }))
    .sort((left, right) => left.score - right.score)
    .slice(0, 3)
    .map(item => path.relative(process.cwd(), item.candidate) || ".");
}

async function collectProjectDirCandidates(rootDir: string, maxDepth: number): Promise<string[]> {
  const results: string[] = [];

  await visit(rootDir, 0);
  return results;

  async function visit(currentDir: string, depth: number): Promise<void> {
    if (depth > maxDepth) {
      return;
    }

    const configNames = ["spec.config.js", "spec.config.mjs", "spec.config.cjs", "spec.config.json"];
    for (const configName of configNames) {
      if (await fileExists(path.join(currentDir, configName))) {
        results.push(currentDir);
        return;
      }
    }

    if (await fileExists(path.join(currentDir, "app.spec"))) {
      results.push(currentDir);
      return;
    }

    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist" || entry.name === "lib") {
        continue;
      }

      await visit(path.join(currentDir, entry.name), depth + 1);
    }
  }
}

function normalizePathForCompare(input: string): string {
  return input.replace(/\\/g, "/").toLowerCase();
}

function levenshtein(left: string, right: string): number {
  const matrix = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));

  for (let row = 0; row <= left.length; row += 1) {
    matrix[row][0] = row;
  }

  for (let column = 0; column <= right.length; column += 1) {
    matrix[0][column] = column;
  }

  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      matrix[row][column] = Math.min(
        matrix[row - 1][column] + 1,
        matrix[row][column - 1] + 1,
        matrix[row - 1][column - 1] + cost
      );
    }
  }

  return matrix[left.length][right.length];
}

function stringFlag(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberFlag(value: string | boolean | undefined): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isSourceLikeFile(filePath: string): boolean {
  return /\.(ts|tsx|js|jsx|json|py|md|txt)$/i.test(filePath);
}

function printFixReport(input: {
  projectDir: string;
  outDir: string;
  errorMessage: string;
  usedLatestStoredError: boolean;
  response: string;
  applyRequested: boolean;
  applyModeResult?: "applied" | "no_fix" | "failed";
  appliedFiles: string[];
}): void {
  const summary = extractFirstNonEmptyLine(input.response) ?? "Diagnosis completed.";
  const fixStatus = input.applyRequested
    ? inferApplyStatus(input.applyModeResult, input.appliedFiles)
    : inferFixStatus(input.response);

  console.log(`${ANSI.cyan}Spec Fix Report${ANSI.reset}`);
  console.log(`Project: ${input.projectDir}`);
  console.log(`Output: ${input.outDir}`);
  console.log(`Input Error: ${input.errorMessage}`);
  console.log(
    `Source: ${input.usedLatestStoredError ? "latest stored project error" : "explicit --error input"}`
  );
  console.log(`AI Analysis: ${summary}`);
  console.log(
    `Status: ${formatStatusLabel(fixStatus)}`
  );
  if (input.applyRequested) {
    console.log(`Mode: apply`);
    if (input.appliedFiles.length > 0) {
      console.log(`Applied Files: ${input.appliedFiles.join(", ")}`);
    }
  }
  console.log("");
  console.log(input.response);
  console.log("");
  console.log(input.applyRequested
    ? `${ANSI.yellow}Note:${ANSI.reset} --apply writes AI-generated file replacements directly into the output directory. Re-run compile or run validation after applying.`
    : `${ANSI.yellow}Note:${ANSI.reset} spec fix currently analyzes and suggests repairs. It does not apply code changes automatically.`);
}

function extractFirstNonEmptyLine(input: string): string | undefined {
  return input
    .split("\n")
    .map(line => line.trim())
    .find(Boolean);
}

function inferFixStatus(response: string): "resolved" | "needs_manual_fix" | "unknown" {
  const normalized = response.toLowerCase();
  if (
    normalized.includes("resolved") ||
    normalized.includes("already fixed") ||
    normalized.includes("no action needed")
  ) {
    return "resolved";
  }

  if (
    normalized.includes("suggested fix") ||
    normalized.includes("what to check") ||
    normalized.includes("root cause") ||
    normalized.includes("repair plan")
  ) {
    return "needs_manual_fix";
  }

  return "unknown";
}

function inferApplyStatus(
  applyModeResult: "applied" | "no_fix" | "failed" | undefined,
  appliedFiles: string[]
): "resolved" | "needs_manual_fix" | "unknown" {
  if (applyModeResult === "applied" && appliedFiles.length > 0) {
    return "resolved";
  }

  if (applyModeResult === "no_fix") {
    return "needs_manual_fix";
  }

  return "unknown";
}

function formatStatusLabel(status: "resolved" | "needs_manual_fix" | "unknown"): string {
  switch (status) {
    case "resolved":
      return `${ANSI.green}resolved${ANSI.reset}`;
    case "needs_manual_fix":
      return `${ANSI.yellow}analysis completed, manual fix still required${ANSI.reset}`;
    default:
      return `${ANSI.yellow}analysis completed, fix status unknown${ANSI.reset}`;
  }
}

type GeneratedFixFile = {
  path: string;
  content: string;
};

function parseGeneratedFilesFromResponse(response: string): GeneratedFixFile[] {
  const files: GeneratedFixFile[] = [];
  const normalized = response.replace(/\r\n/g, "\n");
  const pattern = /FILE:\s*([^\n]+)\n```[a-zA-Z0-9._+-]*\n([\s\S]*?)\n```/g;

  for (const match of normalized.matchAll(pattern)) {
    const filePath = match[1]?.trim();
    if (!filePath) {
      continue;
    }

    files.push({
      path: filePath,
      content: `${(match[2] ?? "").replace(/\s+$/, "")}\n`
    });
  }

  return files;
}

async function applyFixFiles(outDir: string, files: GeneratedFixFile[]): Promise<string[]> {
  const applied: string[] = [];

  for (const file of files) {
    if (!/^(frontend|backend|shared)\//.test(file.path)) {
      continue;
    }

    const targetPath = path.join(outDir, file.path);
    await ensureDirectory(path.dirname(targetPath));
    await writeTextFile(targetPath, file.content);
    applied.push(file.path);
  }

  return applied;
}
