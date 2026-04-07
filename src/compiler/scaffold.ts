import path from "node:path";
import { StackConfig } from "../config/types.js";
import { DEFAULT_STACK } from "../config/project-config.js";
import { ensureDirectory, fileExists, readTextFile, writeTextFile } from "../utils/fs.js";

export type ManagedScaffoldFile = {
  path: string;
  content: string;
};

type ManagedScaffoldTemplate = {
  projectPath: string;
  outputPath: string;
  defaultContent: (stack: StackConfig) => string;
};

const MANAGED_SCAFFOLD_TEMPLATES: ManagedScaffoldTemplate[] = [
  {
    projectPath: ".specos/backend/requirements.txt",
    outputPath: "backend/requirements.txt",
    defaultContent: stack =>
      `${Object.values(stack.backend.dependencies).join("\n")}${stack.backend.dependencies ? "\n" : ""}`
  },
  {
    projectPath: ".specos/frontend/package.json",
    outputPath: "frontend/package.json",
    defaultContent: stack =>
      `${JSON.stringify(
        {
          name: "frontend",
          private: true,
          version: "0.0.0",
          type: "module",
          scripts: {
            dev: `vite --host ${stack.frontend.host} --port ${stack.frontend.port}`,
            start: `vite --host ${stack.frontend.host} --port ${stack.frontend.port}`,
            build: "vite build",
            preview: `vite preview --host ${stack.frontend.host} --port ${stack.frontend.port}`
          },
          dependencies: stack.frontend.dependencies,
          devDependencies: stack.frontend.devDependencies
        },
        null,
        2
      )}\n`
  },
  {
    projectPath: ".specos/frontend/index.html",
    outputPath: "frontend/index.html",
    defaultContent: () => `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>SpecOS App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/index.tsx"></script>
  </body>
</html>
`
  },
  {
    projectPath: ".specos/frontend/tsconfig.json",
    outputPath: "frontend/tsconfig.json",
    defaultContent: () => `{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["DOM", "DOM.Iterable", "ES2020"],
    "allowJs": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "module": "ESNext",
    "moduleResolution": "Node",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx"
  },
  "include": ["src"]
}
`
  },
  {
    projectPath: ".specos/frontend/vite.config.ts",
    outputPath: "frontend/vite.config.ts",
    defaultContent: stack => `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "${stack.frontend.host}",
    port: ${stack.frontend.port},
    proxy: {
      "${stack.frontend.apiBasePath}": {
        target: "${stack.frontend.proxyTarget}",
        changeOrigin: true
      }
    }
  }
});
`
  },
  {
    projectPath: ".specos/frontend/src/vite-env.d.ts",
    outputPath: "frontend/src/vite-env.d.ts",
    defaultContent: () => `/// <reference types="vite/client" />
`
  },
  {
    projectPath: ".specos/.env.example",
    outputPath: ".env.example",
    defaultContent: stack => `HOST=${stack.backend.host}
PORT=${stack.backend.port}
MONGO_URI=${stack.data.uri}
`
  }
];

export async function loadManagedScaffoldFiles(
  projectDir: string,
  _specContext: string,
  stack: StackConfig
): Promise<ManagedScaffoldFile[]> {
  const files: ManagedScaffoldFile[] = [];

  for (const template of MANAGED_SCAFFOLD_TEMPLATES) {
    const sourcePath = path.join(projectDir, template.projectPath);
    const customContent = (await fileExists(sourcePath)) ? await readTextFile(sourcePath) : undefined;
    const content = buildManagedScaffoldContent(template.outputPath, stack, customContent);

    files.push({
      path: template.outputPath,
      content: ensureTrailingNewline(content)
    });
  }

  return files;
}

export async function writeDefaultProjectScaffoldFiles(projectDir: string): Promise<void> {
  for (const template of MANAGED_SCAFFOLD_TEMPLATES) {
    const targetPath = path.join(projectDir, template.projectPath);

    if (await fileExists(targetPath)) {
      continue;
    }

    await ensureDirectory(path.dirname(targetPath));
    await writeTextFile(
      targetPath,
      buildManagedScaffoldContent(template.outputPath, DEFAULT_STACK, undefined)
    );
  }
}

export function listManagedScaffoldPaths(): string[] {
  return MANAGED_SCAFFOLD_TEMPLATES.map(template => template.outputPath);
}

export function shouldUseDevDependency(packageName: string): boolean {
  return (
    packageName.startsWith("@types/") ||
    packageName.startsWith("@vitejs/") ||
    packageName === "typescript" ||
    packageName === "vite"
  );
}

export function inferNodePackageVersion(packageName: string): string {
  const pinnedVersions: Record<string, string> = {
    react: "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.30.1",
    antd: "^5.24.7",
    typescript: "^5.8.2",
    vite: "^5.4.18",
    "@vitejs/plugin-react": "^4.3.4",
    "@types/react": "^18.3.20",
    "@types/react-dom": "^18.3.6"
  };

  return pinnedVersions[packageName] ?? "*";
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function buildManagedScaffoldContent(
  outputPath: string,
  stack: StackConfig,
  customContent?: string
): string {
  switch (outputPath) {
    case "frontend/package.json":
      return buildFrontendPackageJson(stack, customContent);
    case "backend/requirements.txt":
      return buildBackendRequirements(stack, customContent);
    case ".env.example":
      return buildEnvExample(stack, customContent);
    case "frontend/vite.config.ts":
      return buildViteConfig(stack);
    default:
      return customContent ?? getDefaultContent(outputPath, stack);
  }
}

function getDefaultContent(outputPath: string, stack: StackConfig): string {
  const template = MANAGED_SCAFFOLD_TEMPLATES.find(item => item.outputPath === outputPath);

  if (!template) {
    throw new Error(`unknown managed scaffold output path: ${outputPath}`);
  }

  return template.defaultContent(stack);
}

function buildFrontendPackageJson(stack: StackConfig, customContent?: string): string {
  const parsed = parseJsonObject(customContent);
  const scripts = {
    ...(readStringRecord(parsed.scripts) ?? {}),
    dev: `vite --host ${stack.frontend.host} --port ${stack.frontend.port}`,
    start: `vite --host ${stack.frontend.host} --port ${stack.frontend.port}`,
    build: "vite build",
    preview: `vite preview --host ${stack.frontend.host} --port ${stack.frontend.port}`
  };
  const dependencies = sortRecordKeys({
    ...stack.frontend.dependencies,
    ...(readStringRecord(parsed.dependencies) ?? {})
  });
  const devDependencies = sortRecordKeys({
    ...stack.frontend.devDependencies,
    ...(readStringRecord(parsed.devDependencies) ?? {})
  });

  return `${JSON.stringify(
    {
      ...parsed,
      name: readString(parsed.name) ?? "frontend",
      private: readBoolean(parsed.private) ?? true,
      version: readString(parsed.version) ?? "0.0.0",
      type: "module",
      scripts,
      dependencies,
      devDependencies
    },
    null,
    2
  )}\n`;
}

function buildBackendRequirements(stack: StackConfig, customContent?: string): string {
  const linesByPackage = new Map<string, string>();

  for (const dependency of Object.values(stack.backend.dependencies)) {
    linesByPackage.set(normalizeRequirementKey(dependency), dependency);
  }

  for (const dependency of Object.values(stack.data.dependencies)) {
    linesByPackage.set(normalizeRequirementKey(dependency), dependency);
  }

  for (const line of parseRequirements(customContent)) {
    const key = normalizeRequirementKey(line);

    if (!linesByPackage.has(key)) {
      linesByPackage.set(key, line);
    }
  }

  return `${Array.from(linesByPackage.values()).join("\n")}\n`;
}

function buildEnvExample(stack: StackConfig, customContent?: string): string {
  const parsed = parseEnvLines(customContent);
  parsed.HOST = stack.backend.host;
  parsed.PORT = String(stack.backend.port);
  parsed.MONGO_URI = stack.data.uri;

  return `${Object.entries(parsed)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

function buildViteConfig(stack: StackConfig): string {
  return `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "${stack.frontend.host}",
    port: ${stack.frontend.port},
    proxy: {
      "${stack.frontend.apiBasePath}": {
        target: "${stack.frontend.proxyTarget}",
        changeOrigin: true
      }
    }
  }
});
`;
}

function parseJsonObject(content?: string): Record<string, unknown> {
  if (!content?.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(content);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseRequirements(content?: string): string[] {
  if (!content?.trim()) {
    return [];
  }

  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

function normalizeRequirementKey(requirement: string): string {
  const normalized = requirement.trim().toLowerCase();
  const match = normalized.match(/^([a-z0-9._-]+)/);
  return match?.[1] ?? normalized;
}

function parseEnvLines(content?: string): Record<string, string> {
  const result: Record<string, string> = {};

  if (!content?.trim()) {
    return result;
  }

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();

    if (key) {
      result[key] = value;
    }
  }

  return result;
}

function sortRecordKeys(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return Object.fromEntries(entries);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
