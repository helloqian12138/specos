import path from "node:path";
import { pathToFileURL } from "node:url";
import { ProjectConfig, StackConfig } from "./types.js";
import { fileExists, readTextFile } from "../utils/fs.js";

export const DEFAULT_STACK: StackConfig = {
  frontend: "react",
  ui: "antd",
  language: "typescript",
  backend: "flask",
  database: "mongodb"
};

const PROJECT_CONFIG_NAMES = [
  "spec.config.js",
  "spec.config.mjs",
  "spec.config.cjs",
  "spec.config.json"
] as const;

export async function loadProjectConfig(projectDir: string): Promise<ProjectConfig> {
  for (const fileName of PROJECT_CONFIG_NAMES) {
    const configPath = path.join(projectDir, fileName);

    if (!(await fileExists(configPath))) {
      continue;
    }

    if (configPath.endsWith(".json")) {
      return JSON.parse(await readTextFile(configPath)) as ProjectConfig;
    }

    const module = await import(pathToFileURL(configPath).href);
    const loaded = module.default ?? module;

    if (!loaded || typeof loaded !== "object") {
      throw new Error(`project config must export an object: ${configPath}`);
    }

    return loaded as ProjectConfig;
  }

  return {};
}
