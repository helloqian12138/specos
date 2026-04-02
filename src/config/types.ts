export type StackPackageMap = Record<string, string>;

export type FrontendStackConfig = {
  framework: string;
  frameworkVersion?: string;
  ui: string;
  uiVersion?: string;
  language: string;
  languageVersion?: string;
  nodeVersion?: string;
  packageManager?: string;
  host: string;
  port: number;
  apiBasePath: string;
  proxyTarget: string;
  dependencies: StackPackageMap;
  devDependencies: StackPackageMap;
};

export type BackendStackConfig = {
  framework: string;
  frameworkVersion?: string;
  language: string;
  languageVersion?: string;
  host: string;
  port: number;
  entry: string;
  corsOrigins: string[];
  dependencies: StackPackageMap;
};

export type DataStackConfig = {
  engine: string;
  engineVersion?: string;
  uri: string;
  database?: string;
  dependencies: StackPackageMap;
};

export type StackConfig = {
  frontend: FrontendStackConfig;
  backend: BackendStackConfig;
  data: DataStackConfig;
};

export type LegacyStackConfig = {
  frontend?: string;
  ui?: string;
  language?: string;
  backend?: string;
  database?: string;
};

export type ProjectConfig = {
  outDir?: string;
  stackConfig?: string;
  stack?: Partial<LegacyStackConfig>;
  ai?: {
    model?: string;
    temperature?: number;
  };
  compile?: {
    clean?: boolean;
    verbose?: boolean;
  };
};

export type ResolvedCompileConfig = {
  projectDir: string;
  host: string;
  auth: string;
  model: string;
  timeout: number;
  outDir: string;
  stack: StackConfig;
  ai: {
    temperature: number;
  };
  compile: {
    clean: boolean;
    verbose: boolean;
    debug: boolean;
  };
};
