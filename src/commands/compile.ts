import path from "node:path";
import { ParsedArgs } from "../cli.js";
import { compileSpecProject } from "../compiler/compile.js";
import { loadGlobalConfig } from "../config/global-config.js";
import { loadProjectConfig, resolveProjectStackConfig } from "../config/project-config.js";

export async function runCompileCommand(parsed: ParsedArgs): Promise<void> {
  const projectInput = parsed.positionals[0];

  if (!projectInput) {
    throw new Error("compile requires a project directory, for example: spec compile ./examples/users");
  }

  const projectDir = path.resolve(process.cwd(), projectInput);
  const globalConfig = await loadGlobalConfig();
  const projectConfig = await loadProjectConfig(projectDir);
  const resolvedStack = await resolveProjectStackConfig(projectDir, projectConfig);
  const resolved = {
    projectDir,
    host: stringFlag(parsed.flags.host) ?? globalConfig.host ?? "",
    auth: stringFlag(parsed.flags.auth) ?? globalConfig.auth ?? "",
    model:
      stringFlag(parsed.flags.model) ?? projectConfig.ai?.model ?? globalConfig.model ?? "gpt-4o-mini",
    timeout: numberFlag(parsed.flags.timeout) ?? globalConfig.timeout ?? 120000,
    outDir: resolveOutDir(
      projectDir,
      stringFlag(parsed.flags.outDir) ?? projectConfig.outDir ?? globalConfig.dist ?? "./dist"
    ),
    stack: resolvedStack,
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
  console.log(`Compile planning mode: ${result.planning.mode}`);
  console.log(`Dist directory: ${result.planning.outDir}`);

  if (result.planning.installRequired) {
    console.log(`No generated code found in dist. Install is required before subsequent generation.`);
  } else {
    console.log(`Existing generated code found in dist. Subsequent generation should supplement current code.`);
  }

  if (result.planning.installTargets.length > 0) {
    console.log(`Install targets: ${result.planning.installTargets.join(", ")}`);
  }

  if (result.files.length > 0) {
    console.log(`Prepared ${result.files.length} scaffold files in dist for the planning stage.`);
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
