export type StackConfig = {
  frontend: string;
  ui: string;
  language: string;
  backend: string;
  database: string;
};

export type ProjectConfig = {
  outDir?: string;
  stack?: Partial<StackConfig>;
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
