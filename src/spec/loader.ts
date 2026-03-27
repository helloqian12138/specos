import path from "node:path";
import { fileExists, listFilesRecursively, readTextFile } from "../utils/fs.js";
import { SpecFile, SpecProject } from "./types.js";

const SPEC_FILE_EXTENSIONS = new Set([".spec"]);
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", ".specos"]);

export async function loadSpecProject(projectDir: string, outDir: string): Promise<SpecProject> {
  if (!(await fileExists(projectDir))) {
    throw new Error(`project directory not found: ${projectDir}`);
  }

  const entries = await listFilesRecursively(projectDir, {
    shouldEnterDir: (dirName, absolutePath) => {
      if (IGNORED_DIRECTORIES.has(dirName)) {
        return false;
      }

      // The output directory is skipped so a second compile does not feed generated files back into the model.
      return path.resolve(absolutePath) !== path.resolve(outDir);
    }
  });

  const files: SpecFile[] = [];

  for (const absolutePath of entries) {
    if (!SPEC_FILE_EXTENSIONS.has(path.extname(absolutePath))) {
      continue;
    }

    const relativePath = path.relative(projectDir, absolutePath);
    files.push({
      absolutePath,
      relativePath,
      content: await readTextFile(absolutePath)
    });
  }

  if (files.length === 0) {
    throw new Error(`no .spec files found in ${projectDir}`);
  }

  const promptContext = files
    .map(file => `FILE: ${file.relativePath}\n${file.content.trim()}`)
    .join("\n\n---\n\n");

  return {
    rootDir: projectDir,
    files,
    promptContext
  };
}
