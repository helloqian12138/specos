import path from "node:path";
import type { GeneratedFile } from "../compiler/compile.js";
import { ensureDirectory, writeJsonFile, writeTextFile } from "../utils/fs.js";
import fs from "node:fs/promises";

type EmitInput = {
  outDir: string;
  clean: boolean;
  files: GeneratedFile[];
  metadata: {
    generatedAt: string;
    projectDir: string;
    model: string;
    summary: string;
    warnings: string[];
  };
  promptTrace: Record<string, unknown>;
};

export async function emitGeneratedProject(input: EmitInput): Promise<void> {
  if (input.clean) {
    await fs.rm(input.outDir, { recursive: true, force: true });
  }

  await ensureDirectory(input.outDir);

  for (const file of input.files) {
    const targetPath = path.join(input.outDir, file.path);
    await ensureDirectory(path.dirname(targetPath));
    await writeTextFile(targetPath, file.content);
  }

  const metaDir = path.join(input.outDir, ".specos");
  await ensureDirectory(metaDir);

  await writeJsonFile(path.join(metaDir, "compile-log.json"), input.metadata);
  await writeJsonFile(
    path.join(metaDir, "file-manifest.json"),
    input.files.map(file => ({ path: file.path }))
  );
  await writeJsonFile(path.join(metaDir, "prompt-trace.json"), input.promptTrace);
}
