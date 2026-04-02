import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  BackendStackConfig,
  DataStackConfig,
  FrontendStackConfig,
  LegacyStackConfig,
  ProjectConfig,
  StackConfig
} from "./types.js";
import { fileExists, readTextFile } from "../utils/fs.js";

type StackConfigPatch = {
  frontend?: Partial<FrontendStackConfig>;
  backend?: Partial<BackendStackConfig>;
  data?: Partial<DataStackConfig>;
};

export const DEFAULT_STACK: StackConfig = {
  frontend: {
    framework: "react",
    frameworkVersion: "18.3.1",
    ui: "antd",
    uiVersion: "5.24.7",
    language: "typescript",
    languageVersion: "5.8.2",
    nodeVersion: "18",
    packageManager: "npm",
    host: "0.0.0.0",
    port: 3000,
    apiBasePath: "/api",
    proxyTarget: "http://127.0.0.1:5000",
    dependencies: {
      antd: "^5.24.7",
      react: "^18.3.1",
      "react-dom": "^18.3.1",
      "react-router-dom": "^6.30.1"
    },
    devDependencies: {
      "@types/react": "^18.3.20",
      "@types/react-dom": "^18.3.6",
      "@vitejs/plugin-react": "^4.3.4",
      typescript: "^5.8.2",
      vite: "^5.4.18"
    }
  },
  backend: {
    framework: "flask",
    frameworkVersion: "3.0",
    language: "python",
    languageVersion: "3.11",
    host: "127.0.0.1",
    port: 5000,
    entry: "app.py",
    corsOrigins: ["http://localhost:3000", "http://127.0.0.1:3000"],
    dependencies: {
      Flask: "Flask>=3.0,<3.1",
      "Flask-Cors": "Flask-Cors>=4.0,<5.0"
    }
  },
  data: {
    engine: "mongodb",
    engineVersion: "7",
    uri: "mongodb://127.0.0.1:27017/specos",
    database: "specos",
    dependencies: {
      pymongo: "pymongo>=4.6,<5.0"
    }
  }
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

export async function resolveProjectStackConfig(
  projectDir: string,
  projectConfig: ProjectConfig
): Promise<StackConfig> {
  const stackFromFile = projectConfig.stackConfig
    ? await loadStackConfig(projectDir, projectConfig.stackConfig)
    : undefined;

  const merged = mergeStackConfig(
    DEFAULT_STACK,
    stackFromFile ?? {},
    mapLegacyStackConfig(projectConfig.stack)
  );

  return normalizeStackConfig(merged);
}

async function loadStackConfig(projectDir: string, configPathValue: string): Promise<StackConfigPatch> {
  const configPath = path.resolve(projectDir, configPathValue);

  if (!(await fileExists(configPath))) {
    throw new Error(`stack config not found: ${configPath}`);
  }

  if (configPath.endsWith(".json")) {
    return JSON.parse(await readTextFile(configPath)) as StackConfigPatch;
  }

  const module = await import(pathToFileURL(configPath).href);
  const loaded = module.default ?? module;

  if (!loaded || typeof loaded !== "object") {
    throw new Error(`stack config must export an object: ${configPath}`);
  }

  return loaded as StackConfigPatch;
}

function mapLegacyStackConfig(legacy?: Partial<LegacyStackConfig>): StackConfigPatch {
  if (!legacy) {
    return {};
  }

  return {
    frontend: {
      ...(legacy.frontend ? { framework: legacy.frontend } : {}),
      ...(legacy.ui ? { ui: legacy.ui } : {}),
      ...(legacy.language ? { language: legacy.language } : {})
    },
    backend: legacy.backend
      ? {
          framework: legacy.backend
        }
      : undefined,
    data: legacy.database
      ? {
          engine: legacy.database
        }
      : undefined
  };
}

function mergeStackConfig(...layers: StackConfigPatch[]): StackConfig {
  const merged: StackConfig = structuredClone(DEFAULT_STACK);

  for (const layer of layers) {
    if (layer.frontend) {
      merged.frontend = {
        ...merged.frontend,
        ...layer.frontend,
        dependencies: {
          ...merged.frontend.dependencies,
          ...(layer.frontend.dependencies ?? {})
        },
        devDependencies: {
          ...merged.frontend.devDependencies,
          ...(layer.frontend.devDependencies ?? {})
        }
      };
    }

    if (layer.backend) {
      merged.backend = {
        ...merged.backend,
        ...layer.backend,
        dependencies: {
          ...merged.backend.dependencies,
          ...(layer.backend.dependencies ?? {})
        },
        corsOrigins: layer.backend.corsOrigins ?? merged.backend.corsOrigins
      };
    }

    if (layer.data) {
      merged.data = {
        ...merged.data,
        ...layer.data,
        dependencies: {
          ...merged.data.dependencies,
          ...(layer.data.dependencies ?? {})
        }
      };
    }
  }

  return merged;
}

function normalizeStackConfig(stack: StackConfig): StackConfig {
  const backendOrigin = `http://${stack.backend.host}:${stack.backend.port}`;
  const frontendCors = [`http://localhost:${stack.frontend.port}`, `http://127.0.0.1:${stack.frontend.port}`];

  return {
    ...stack,
    frontend: {
      ...stack.frontend,
      proxyTarget: stack.frontend.proxyTarget || backendOrigin
    },
    backend: {
      ...stack.backend,
      corsOrigins: stack.backend.corsOrigins.length > 0 ? stack.backend.corsOrigins : frontendCors
    }
  };
}
