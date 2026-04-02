export default {
  outDir: "./dist",
  stackConfig: "./stack.config.js",
  ai: {
    model: "gpt-4o-mini",
    temperature: 0.2
  },
  compile: {
    clean: false,
    verbose: true
  }
}
