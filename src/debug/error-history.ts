import fs from "node:fs/promises";
import path from "node:path";
import { ensureDirectory, fileExists, readTextFile, writeJsonFile } from "../utils/fs.js";

export type ErrorLogEntry = {
  timestamp: string;
  command: string;
  projectDir: string;
  cwd: string;
  error: string;
  flags: Record<string, string | boolean>;
};

export async function writeProjectErrorLog(entry: ErrorLogEntry): Promise<void> {
  const metaDir = path.join(entry.projectDir, ".specos");
  await ensureDirectory(metaDir);

  const latestPath = path.join(metaDir, "latest-error.json");
  const historyPath = path.join(metaDir, "error-history.jsonl");

  await writeJsonFile(latestPath, entry);
  await fs.appendFile(historyPath, `${JSON.stringify(entry)}\n`, "utf8");
}

export async function readLatestProjectError(projectDir: string): Promise<ErrorLogEntry | undefined> {
  const latestPath = path.join(projectDir, ".specos", "latest-error.json");
  if (!(await fileExists(latestPath))) {
    return undefined;
  }

  return JSON.parse(await readTextFile(latestPath)) as ErrorLogEntry;
}
