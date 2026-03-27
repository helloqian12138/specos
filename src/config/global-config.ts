import os from "node:os";
import path from "node:path";
import { ensureDirectory, fileExists, readTextFile, writeTextFile } from "../utils/fs.js";

export type GlobalConfig = {
  host?: string;
  auth?: string;
  model?: string;
  dist?: string;
  timeout?: number;
};

export async function loadGlobalConfig(): Promise<GlobalConfig> {
  const configPath = getGlobalConfigPath();

  if (!(await fileExists(configPath))) {
    return {};
  }

  return JSON.parse(await readTextFile(configPath)) as GlobalConfig;
}

export async function saveGlobalConfig(config: GlobalConfig): Promise<void> {
  const configPath = getGlobalConfigPath();
  await ensureDirectory(path.dirname(configPath));
  await writeTextFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

export function getGlobalConfigPath(): string {
  const override = process.env.SPECOS_CONFIG;

  // An env override makes local testing and CI deterministic without touching the user home directory.
  if (override) {
    return path.resolve(override);
  }

  return path.join(os.homedir(), ".specos", "config.json");
}
