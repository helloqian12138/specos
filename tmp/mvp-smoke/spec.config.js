export default {
  outDir: "./dist",
  stack: {
    frontend: "react",
    ui: "antd",
    language: "typescript",
    backend: "flask",
    database: "mongodb"
  },
  ai: {
    model: "gpt-4o-mini",
    temperature: 0.2
  },
  compile: {
    clean: false,
    verbose: true
  }
}
