export type SpecFile = {
  absolutePath: string;
  relativePath: string;
  content: string;
};

export type SpecProject = {
  rootDir: string;
  files: SpecFile[];
  promptContext: string;
};
