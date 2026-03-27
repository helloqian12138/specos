# SpecOS

> Structured spec in. Runnable project out.

SpecOS is a TypeScript CLI for compiling a structured spec project into a runnable application skeleton with AI.

Current MVP:

- Node.js `>= 18`
- npm-style CLI package
- project-local `spec.config.js`
- global API initialization through `spec init`
- AI compile pipeline through `spec compile <projectDir>`
- target stack: `React + Ant Design + TypeScript + Flask + MongoDB`

## Product Model

SpecOS is intentionally spec-driven:

```text
spec project -> AI compile -> runnable frontend + backend project
```

The source of truth is the spec project directory, not the generated code in `dist`.

## Commands

Initialize global API config:

```bash
spec init --host https://api.openai.com/v1 --auth sk-...
```

Or load it from a file:

```bash
spec init --config ./spec.global.json
```

Create a project template:

```bash
spec init --project ./examples/my-app
```

Compile a spec project:

```bash
spec compile ./examples/todo-app
```

Override output or model at compile time:

```bash
spec compile ./examples/todo-app --outDir ./dist --model gpt-4o-mini
```

## Project Config

Each spec project can define its own `spec.config.js`:

```js
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
```

Config precedence:

```text
CLI flags > project spec.config.js > global spec init config
```

`auth` should stay in the global config, not in project files.

## Example Spec Project

```text
examples/todo-app/
├── spec.config.js
└── app.spec
```

The MVP scans `.spec` files recursively and sends the merged spec context to the model.

## Compile Output

Generated files are written into the configured `outDir`.

SpecOS also writes metadata into:

```text
dist/.specos/
├── compile-log.json
├── file-manifest.json
└── prompt-trace.json
```

## Local Development

Install dependencies and build:

```bash
npm install
npm run build
```

Run the compiled CLI locally:

```bash
node ./lib/index.js compile ./examples/todo-app
```

## Repository Layout

```text
specos/
├── examples/
│   └── todo-app/
├── src/
├── docs/
├── demo/
├── README.md
└── README.zh.md
```

## Language

English (default) · Chinese: [`README.zh.md`](./README.zh.md)
