import path from "node:path";
import { ParsedArgs } from "../cli.js";
import { compileSpecProject } from "../compiler/compile.js";
import { loadGlobalConfig } from "../config/global-config.js";
import {
  DEFAULT_STACK,
  loadProjectConfig
} from "../config/project-config.js";
import { ResolvedCompileConfig } from "../config/types.js";

export async function runCompileCommand(parsed: ParsedArgs): Promise<void> {
  const projectInput = parsed.positionals[0];

  if (!projectInput) {
    throw new Error("compile requires a project directory, for example: spec compile ./examples/todo-app");
  }

  const projectDir = path.resolve(process.cwd(), projectInput);
  const globalConfig = await loadGlobalConfig();
  const projectConfig = await loadProjectConfig(projectDir);
  const host = stringFlag(parsed.flags.host) ?? globalConfig.host;
  const auth = stringFlag(parsed.flags.auth) ?? globalConfig.auth;

  if (!host || !auth) {
    throw new Error("missing API credentials. Run `spec init --host ... --auth ...` first, or pass --host and --auth.");
  }

  const resolved: ResolvedCompileConfig = {
    projectDir,
    host,
    auth,
    model:
      stringFlag(parsed.flags.model) ??
      projectConfig.ai?.model ??
      globalConfig.model ??
      "gpt-4o-mini",
    timeout: numberFlag(parsed.flags.timeout) ?? globalConfig.timeout ?? 120000,
    outDir: resolveOutDir(
      projectDir,
      stringFlag(parsed.flags.outDir) ?? projectConfig.outDir ?? globalConfig.dist ?? "./dist"
    ),
    stack: {
      ...DEFAULT_STACK,
      ...projectConfig.stack
    },
    ai: {
      temperature: projectConfig.ai?.temperature ?? 0.2
    },
    compile: {
      clean: projectConfig.compile?.clean ?? false,
      verbose: booleanFlag(parsed.flags.verbose) ?? projectConfig.compile?.verbose ?? true,
      debug: booleanFlag(parsed.flags.debug) ?? false
    }
  };

  const result = await compileSpecProject(resolved);
  console.log(`Compiled ${result.files.length} files into ${resolved.outDir}`);

  if (result.warnings.length > 0) {
    console.log("Warnings:");
    for (const warning of result.warnings) {
      console.log(`- ${warning}`);
    }
  }
}

function resolveOutDir(projectDir: string, outDir: string): string {
  return path.resolve(projectDir, outDir);
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

function booleanFlag(value: string | boolean | undefined): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    if (value === "true") {
      return true;
    }
    if (value === "false") {
      return false;
    }
  }

  return undefined;
}
