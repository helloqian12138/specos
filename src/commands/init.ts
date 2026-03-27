import path from "node:path";
import { pathToFileURL } from "node:url";
import { ParsedArgs } from "../cli.js";
import {
  GlobalConfig,
  loadGlobalConfig,
  saveGlobalConfig
} from "../config/global-config.js";
import { ensureDirectory, fileExists, writeTextFile } from "../utils/fs.js";

export async function runInitCommand(parsed: ParsedArgs): Promise<void> {
  if (parsed.flags.project) {
    const targetInput =
      typeof parsed.flags.project === "string" ? parsed.flags.project : parsed.positionals[0];
    const targetDir = resolveProjectDir(targetInput);
    await createProjectTemplate(targetDir, parsed.flags.force === true);
    console.log(`Project template created at ${path.join(targetDir, "spec.config.js")}`);
    return;
  }

  const nextConfig = await resolveGlobalConfigInput(parsed.flags);
  const merged = {
    ...(await loadGlobalConfig()),
    ...nextConfig
  };

  if (!merged.host || !merged.auth) {
    throw new Error("init requires host and auth, either from flags or from --config");
  }

  await saveGlobalConfig(merged);
  console.log("Global SpecOS config saved");
}

async function resolveGlobalConfigInput(
  flags: ParsedArgs["flags"]
): Promise<Partial<GlobalConfig>> {
  if (typeof flags.config === "string") {
    const configPath = path.resolve(process.cwd(), flags.config);
    const loaded = await loadConfigModule(configPath);
    return normalizeGlobalConfig(loaded);
  }

  return normalizeGlobalConfig({
    host: flags.host,
    auth: flags.auth,
    model: flags.model,
    dist: flags.dist,
    timeout: flags.timeout
  });
}

function normalizeGlobalConfig(input: Record<string, unknown>): Partial<GlobalConfig> {
  const next: Partial<GlobalConfig> = {};

  if (typeof input.host === "string") {
    next.host = input.host;
  }
  if (typeof input.auth === "string") {
    next.auth = input.auth;
  }
  if (typeof input.model === "string") {
    next.model = input.model;
  }
  if (typeof input.dist === "string") {
    next.dist = input.dist;
  }
  if (typeof input.timeout === "number") {
    next.timeout = input.timeout;
  }
  if (typeof input.timeout === "string") {
    next.timeout = Number(input.timeout);
  }

  return next;
}

async function loadConfigModule(configPath: string): Promise<Record<string, unknown>> {
  if (!(await fileExists(configPath))) {
    throw new Error(`config file not found: ${configPath}`);
  }

  if (configPath.endsWith(".json")) {
    const { readTextFile } = await import("../utils/fs.js");
    return JSON.parse(await readTextFile(configPath)) as Record<string, unknown>;
  }

  const module = await import(pathToFileURL(configPath).href);
  const loaded = module.default ?? module;

  if (!loaded || typeof loaded !== "object") {
    throw new Error(`config file must export an object: ${configPath}`);
  }

  return loaded as Record<string, unknown>;
}

function resolveProjectDir(input?: string): string {
  return path.resolve(process.cwd(), input ?? ".");
}

async function createProjectTemplate(targetDir: string, force: boolean): Promise<void> {
  const configPath = path.join(targetDir, "spec.config.js");
  const specPath = path.join(targetDir, "app.spec");

  if (!force && (await fileExists(configPath))) {
    throw new Error(`project config already exists: ${configPath}`);
  }

  await ensureDirectory(targetDir);

  // The template stays small on purpose so new projects start from an editable baseline.
  await writeTextFile(
    configPath,
    `export default {
  outDir: "./dist",
  stack: {
    frontend: "react",
    ui: "antd",
    language: "typescript",
    backend: "flask",
    database: "mongodb"
  },
  ai: {
    model: "gpt-4o-mini",
    temperature: 0.2
  },
  compile: {
    clean: false,
    verbose: true
  }
}
`
  );

  if (!(await fileExists(specPath))) {
    await writeTextFile(
      specPath,
      `App:

Goal:
  Describe your system here.

Environment:
  Frontend: React + Ant Design + TypeScript
  Backend: Python + Flask
  Data: MongoDB
`
    );
  }
}
