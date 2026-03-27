import fs from "node:fs/promises";
import path from "node:path";

export async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDirectory(targetDir: string): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true });
}

export async function readTextFile(targetPath: string): Promise<string> {
  return fs.readFile(targetPath, "utf8");
}

export async function writeTextFile(targetPath: string, content: string): Promise<void> {
  await fs.writeFile(targetPath, content, "utf8");
}

export async function writeJsonFile(targetPath: string, payload: unknown): Promise<void> {
  await writeTextFile(targetPath, `${JSON.stringify(payload, null, 2)}\n`);
}

export async function listFilesRecursively(
  rootDir: string,
  options: {
    shouldEnterDir?: (dirName: string, absolutePath: string) => boolean;
  } = {}
): Promise<string[]> {
  const result: string[] = [];

  await visit(rootDir);
  return result;

  async function visit(currentDir: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (options.shouldEnterDir && !options.shouldEnterDir(entry.name, absolutePath)) {
          continue;
        }

        await visit(absolutePath);
        continue;
      }

      result.push(absolutePath);
    }
  }
}
