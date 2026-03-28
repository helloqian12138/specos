import path from "node:path";
import { ensureDirectory, fileExists, readTextFile, writeTextFile } from "../utils/fs.js";

export type ManagedScaffoldFile = {
  path: string;
  content: string;
};

type ScaffoldTemplate = {
  projectPath: string;
  outputPath: string;
  defaultContent: (specContext: string) => string;
};

const MANAGED_SCAFFOLD_TEMPLATES: ScaffoldTemplate[] = [
  {
    projectPath: ".specos/backend/requirements.txt",
    outputPath: "backend/requirements.txt",
    defaultContent: specContext => buildManagedBackendRequirements(specContext, undefined)
  },
  {
    projectPath: ".specos/frontend/package.json",
    outputPath: "frontend/package.json",
    defaultContent: specContext => buildManagedFrontendPackageJson(undefined, specContext)
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
  "include": ["src"],
  "references": []
}
`
  },
  {
    projectPath: ".specos/frontend/vite.config.ts",
    outputPath: "frontend/vite.config.ts",
    defaultContent: () => `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 3000,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5000",
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
    defaultContent: () => `PORT=5000
MONGO_URI=mongodb://127.0.0.1:27017/specos
`
  }
];

type PackageManifest = {
  name?: string;
  private?: boolean;
  version?: string;
  type?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
};

export async function loadManagedScaffoldFiles(
  projectDir: string,
  specContext: string
): Promise<ManagedScaffoldFile[]> {
  const files: ManagedScaffoldFile[] = [];

  for (const template of MANAGED_SCAFFOLD_TEMPLATES) {
    const sourcePath = path.join(projectDir, template.projectPath);
    const customContent = (await fileExists(sourcePath)) ? await readTextFile(sourcePath) : undefined;
    const content =
      template.outputPath === "frontend/package.json"
        ? buildManagedFrontendPackageJson(customContent, specContext)
        : template.outputPath === "backend/requirements.txt"
          ? buildManagedBackendRequirements(specContext, customContent)
        : customContent ?? template.defaultContent(specContext);

    files.push({
      path: template.outputPath,
      content
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
    await writeTextFile(targetPath, template.defaultContent(""));
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
    axios: "^1.8.4",
    dayjs: "^1.11.13",
    "@tanstack/react-query": "^5.74.4",
    zustand: "^5.0.3",
    "react-hook-form": "^7.56.1",
    vite: "^5.4.18",
    "@vitejs/plugin-react": "^4.3.4",
    typescript: "^5.8.2",
    "@types/react": "^18.3.20",
    "@types/react-dom": "^18.3.6"
  };

  return pinnedVersions[packageName] ?? "*";
}

function buildManagedFrontendPackageJson(
  packageJsonContent: string | undefined,
  specContext: string
): string {
  const manifest = parsePackageManifest(packageJsonContent);
  const baseManifest = createBaseFrontendManifest();

  const nextManifest: PackageManifest = {
    ...baseManifest,
    ...manifest,
    scripts: {
      ...baseManifest.scripts,
      ...(manifest.scripts ?? {})
    },
    dependencies: {
      ...baseManifest.dependencies,
      ...(manifest.dependencies ?? {})
    },
    devDependencies: {
      ...baseManifest.devDependencies,
      ...(manifest.devDependencies ?? {})
    }
  };

  for (const packageName of extractFrontendPackagesFromSpec(specContext)) {
    const dependencyGroup = shouldUseDevDependency(packageName)
      ? (nextManifest.devDependencies ?? {})
      : (nextManifest.dependencies ?? {});
    if (!dependencyGroup[packageName]) {
      dependencyGroup[packageName] = inferNodePackageVersion(packageName);
    }
  }

  nextManifest.name = typeof nextManifest.name === "string" && nextManifest.name.trim()
    ? nextManifest.name
    : "frontend";
  nextManifest.private = true;
  nextManifest.version = typeof nextManifest.version === "string" ? nextManifest.version : "0.0.0";
  nextManifest.type = "module";
  nextManifest.dependencies = sortRecordKeys(nextManifest.dependencies ?? {});
  nextManifest.devDependencies = sortRecordKeys(nextManifest.devDependencies ?? {});

  return `${JSON.stringify(nextManifest, null, 2)}\n`;
}

function createBaseFrontendManifest(): PackageManifest {
  return {
    name: "frontend",
    private: true,
    version: "0.0.0",
    type: "module",
    scripts: {
      dev: "vite --host 0.0.0.0 --port 3000",
      start: "vite --host 0.0.0.0 --port 3000",
      build: "vite build",
      preview: "vite preview --host 0.0.0.0 --port 3000"
    },
    dependencies: {
      antd: inferNodePackageVersion("antd"),
      react: inferNodePackageVersion("react"),
      "react-dom": inferNodePackageVersion("react-dom"),
      "react-router-dom": inferNodePackageVersion("react-router-dom")
    },
    devDependencies: {
      "@types/react": inferNodePackageVersion("@types/react"),
      "@types/react-dom": inferNodePackageVersion("@types/react-dom"),
      "@vitejs/plugin-react": inferNodePackageVersion("@vitejs/plugin-react"),
      typescript: inferNodePackageVersion("typescript"),
      vite: inferNodePackageVersion("vite")
    }
  };
}

function parsePackageManifest(content: string | undefined): PackageManifest {
  if (!content?.trim()) {
    return {};
  }

  try {
    return JSON.parse(content) as PackageManifest;
  } catch {
    return {};
  }
}

function extractFrontendPackagesFromSpec(specContext: string): string[] {
  const match = specContext.match(/Frontend:\s*([^\n]+)/i);
  if (!match?.[1]) {
    return [];
  }

  const packages = new Set<string>();
  const rawTokens = match[1]
    .split(/[+,]/)
    .map(token => token.trim())
    .filter(Boolean);

  for (const token of rawTokens) {
    const packageNames = mapFrontendEnvironmentTokenToPackages(token);
    for (const packageName of packageNames) {
      if (packageName) {
        packages.add(packageName);
      }
    }
  }

  return Array.from(packages);
}

function mapFrontendEnvironmentTokenToPackages(token: string): string[] {
  const normalized = token.trim().toLowerCase();
  if (!normalized) {
    return [];
  }

  const mapped = FRONTEND_ENVIRONMENT_PACKAGE_MAP[normalized];
  if (mapped) {
    return mapped;
  }

  if (isBuiltinFrontendDescriptor(normalized)) {
    return [];
  }

  if (normalized.startsWith("@")) {
    return [normalized];
  }

  return [normalized.replace(/[^a-z0-9/@\s-]/g, "").trim().replace(/\s+/g, "-")].filter(Boolean);
}

function isBuiltinFrontendDescriptor(token: string): boolean {
  return [
    "react",
    "typescript",
    "javascript",
    "ts",
    "js",
    "vite",
    "frontend"
  ].includes(token);
}

const FRONTEND_ENVIRONMENT_PACKAGE_MAP: Record<string, string[]> = {
  "ant design": ["antd"],
  antd: ["antd"],
  axios: ["axios"],
  dayjs: ["dayjs"],
  "day.js": ["dayjs"],
  "react router": ["react-router-dom"],
  "react router dom": ["react-router-dom"],
  "react-router-dom": ["react-router-dom"],
  "react query": ["@tanstack/react-query"],
  "tanstack query": ["@tanstack/react-query"],
  "@tanstack/react-query": ["@tanstack/react-query"],
  zustand: ["zustand"],
  "react hook form": ["react-hook-form"],
  "react-hook-form": ["react-hook-form"]
};

function buildManagedBackendRequirements(
  specContext: string,
  requirementsContent: string | undefined
): string {
  const declaredPackages = new Map<string, string>();

  for (const line of (requirementsContent ?? "")
    .split("\n")
    .map(value => value.trim())
    .filter(value => value.length > 0 && !value.startsWith("#"))) {
    declaredPackages.set(normalizePythonPackageKey(line), line);
  }

  for (const packageName of extractBackendPackagesFromSpec(specContext)) {
    declaredPackages.set(normalizePythonPackageKey(packageName), packageName);
  }

  return `${Array.from(declaredPackages.values()).sort((left, right) => left.localeCompare(right)).join("\n")}\n`;
}

function extractBackendPackagesFromSpec(specContext: string): string[] {
  const packages = new Set<string>([
    inferPythonPackageRequirement("Flask"),
    inferPythonPackageRequirement("Flask-Cors")
  ]);

  for (const token of extractEnvironmentTokens(specContext, "Backend")) {
    for (const packageName of mapBackendEnvironmentTokenToPackages(token)) {
      packages.add(inferPythonPackageRequirement(packageName));
    }
  }

  for (const token of extractEnvironmentTokens(specContext, "Data")) {
    for (const packageName of mapDataEnvironmentTokenToPackages(token)) {
      packages.add(inferPythonPackageRequirement(packageName));
    }
  }

  return Array.from(packages);
}

function extractEnvironmentTokens(specContext: string, label: "Frontend" | "Backend" | "Data"): string[] {
  const match = specContext.match(new RegExp(`${label}:\\s*([^\\n]+)`, "i"));
  if (!match?.[1]) {
    return [];
  }

  return match[1]
    .split(/[+,]/)
    .map(token => token.trim())
    .filter(Boolean);
}

function mapBackendEnvironmentTokenToPackages(token: string): string[] {
  const normalized = token.trim().toLowerCase();
  if (!normalized || ["python", "backend"].includes(normalized)) {
    return [];
  }

  const mapped = BACKEND_ENVIRONMENT_PACKAGE_MAP[normalized];
  if (mapped) {
    return mapped;
  }

  return [token.trim()].filter(Boolean);
}

function mapDataEnvironmentTokenToPackages(token: string): string[] {
  const normalized = token.trim().toLowerCase();
  if (!normalized || ["data", "database"].includes(normalized)) {
    return [];
  }

  const mapped = DATA_ENVIRONMENT_PACKAGE_MAP[normalized];
  if (mapped) {
    return mapped;
  }

  return [];
}

const BACKEND_ENVIRONMENT_PACKAGE_MAP: Record<string, string[]> = {
  flask: ["Flask", "Flask-Cors"],
  fastapi: ["fastapi", "uvicorn"],
  django: ["Django"]
};

const DATA_ENVIRONMENT_PACKAGE_MAP: Record<string, string[]> = {
  mongodb: ["pymongo"],
  mongo: ["pymongo"],
  postgres: ["psycopg[binary]"],
  postgresql: ["psycopg[binary]"],
  mysql: ["PyMySQL"],
  sqlite: []
};

function inferPythonPackageRequirement(packageName: string): string {
  const normalized = normalizePythonPackageKey(packageName);
  const pinnedRequirements: Record<string, string> = {
    flask: "Flask>=3.0,<3.1",
    "flask-cors": "Flask-Cors>=4.0,<5.0",
    pymongo: "pymongo>=4.6,<5.0",
    "psycopg[binary]": "psycopg[binary]>=3.1,<3.3",
    pymysql: "PyMySQL>=1.1,<2.0",
    fastapi: "fastapi>=0.110,<0.116",
    uvicorn: "uvicorn>=0.27,<0.35",
    django: "Django>=5.0,<5.2"
  };

  return pinnedRequirements[normalized] ?? packageName;
}

function normalizePythonPackageKey(packageName: string): string {
  const normalized = packageName.trim().toLowerCase();
  const match = normalized.match(/^([a-z0-9_.-]+(?:\[[a-z0-9_,.-]+\])?)/);
  return match?.[1] ?? normalized;
}

function sortRecordKeys(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right))
  );
}
