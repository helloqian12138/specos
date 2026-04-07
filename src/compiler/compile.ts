import path from "node:path";
import { ResolvedCompileConfig } from "../config/types.js";
import { loadSpecProject } from "../spec/loader.js";
import { ensureDirectory, fileExists, listFilesRecursively, writeJsonFile, writeTextFile } from "../utils/fs.js";
import { createLogger } from "../utils/logger.js";
import { listManagedScaffoldPaths, loadManagedScaffoldFiles } from "./scaffold.js";

export type GeneratedFile = {
  path: string;
  content: string;
};

export type CompilePlanMode = "bootstrap" | "supplement";

export type CompilePlanningSummary = {
  mode: CompilePlanMode;
  outDir: string;
  hasGeneratedCode: boolean;
  installRequired: boolean;
  installTargets: Array<"frontend" | "backend">;
  existingGeneratedFiles: string[];
  managedScaffoldFiles: string[];
  nextSteps: string[];
};

export type CompileResult = {
  files: GeneratedFile[];
  warnings: string[];
  planning: CompilePlanningSummary;
};

type ExistingOutputSnapshot = {
  hasGeneratedCode: boolean;
  generatedFiles: string[];
};

export async function compileSpecProject(config: ResolvedCompileConfig): Promise<CompileResult> {
  const logger = createLogger(config.compile.verbose);

  logger.step("1/4", `Loading spec project from ${config.projectDir}`);
  const specProject = await loadSpecProject(config.projectDir, config.outDir);

  logger.step("2/4", `Inspecting dist directory ${config.outDir}`);
  const outputSnapshot = await inspectExistingOutput(config.outDir);
  const mode: CompilePlanMode = outputSnapshot.hasGeneratedCode ? "supplement" : "bootstrap";

  logger.step("3/4", "Preparing managed scaffold files for planning");
  const managedScaffoldFiles = await loadManagedScaffoldFiles(
    config.projectDir,
    specProject.promptContext,
    config.stack
  );

  const writtenFiles: GeneratedFile[] = [];

  if (mode === "bootstrap") {
    await ensureDirectory(config.outDir);

    for (const file of managedScaffoldFiles) {
      const targetPath = path.join(config.outDir, file.path);
      await ensureDirectory(path.dirname(targetPath));
      await writeTextFile(targetPath, file.content);
      writtenFiles.push(file);
    }
  }

  const planning: CompilePlanningSummary = {
    mode,
    outDir: config.outDir,
    hasGeneratedCode: outputSnapshot.hasGeneratedCode,
    installRequired: mode === "bootstrap",
    installTargets: detectInstallTargets(config),
    existingGeneratedFiles: outputSnapshot.generatedFiles,
    managedScaffoldFiles: managedScaffoldFiles.map(file => file.path),
    nextSteps:
      mode === "bootstrap"
        ? [
            "Install frontend/backend runtime dependencies into the dist scaffold.",
            "Generate initial application code into dist based on the spec.",
            "Run follow-up verification on the generated project."
          ]
        : [
            "Read existing generated code from dist as generation context.",
            "Generate only the missing or changed files required by the latest spec.",
            "Run follow-up verification on the supplemented project."
          ]
  };

  logger.step("4/4", `Planning mode selected: ${planning.mode}`);
  await persistCompilePlanningArtifacts(config.outDir, planning);

  return {
    files: writtenFiles,
    warnings: [],
    planning
  };
}

async function inspectExistingOutput(outDir: string): Promise<ExistingOutputSnapshot> {
  if (!(await fileExists(outDir))) {
    return {
      hasGeneratedCode: false,
      generatedFiles: []
    };
  }

  const allFiles = await listFilesRecursively(outDir, {
    shouldEnterDir: dirName => !IGNORED_OUTPUT_DIRECTORIES.has(dirName)
  });
  const managedScaffoldPaths = new Set(listManagedScaffoldPaths());
  const generatedFiles = allFiles
    .map(filePath => path.relative(outDir, filePath))
    .filter(relativePath => !managedScaffoldPaths.has(relativePath))
    .sort();

  return {
    hasGeneratedCode: generatedFiles.length > 0,
    generatedFiles
  };
}

async function persistCompilePlanningArtifacts(
  outDir: string,
  planning: CompilePlanningSummary
): Promise<void> {
  const metaDir = path.join(outDir, ".specos");
  await ensureDirectory(metaDir);
  await writeJsonFile(path.join(metaDir, "compile-plan.json"), {
    createdAt: new Date().toISOString(),
    stage: "planning",
    ...planning
  });
}

function detectInstallTargets(config: ResolvedCompileConfig): Array<"frontend" | "backend"> {
  const targets: Array<"frontend" | "backend"> = [];

  if (!isDisabledValue(config.stack.frontend.framework)) {
    targets.push("frontend");
  }

  if (!isDisabledValue(config.stack.backend.framework)) {
    targets.push("backend");
  }

  return targets;
}

function isDisabledValue(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  return ["none", "no", "false", "disabled", "disable", "null", "n/a"].includes(
    value.trim().toLowerCase()
  );
}

const IGNORED_OUTPUT_DIRECTORIES = new Set([".specos", "node_modules", ".venv", "__pycache__"]);
