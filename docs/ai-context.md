# SpecOS AI Context

## Overview

SpecOS is currently implemented as a TypeScript CLI for compiling a structured spec project into a runnable full-stack project with AI.

The current workflow is:

```text
spec project directory -> AI compile -> dist project output
```

The source of truth is the spec project directory, not the generated `dist` files.

## Current Repository State

The repository now contains an MVP CLI with these layers:

- `src/commands/init.ts`: initializes global API config or creates a project template
- `src/commands/compile.ts`: resolves config and starts the compile pipeline
- `src/spec/loader.ts`: scans a spec project directory for `.spec` files
- `src/ai/openai-client.ts`: calls an OpenAI-compatible HTTP API
- `src/compiler/compile.ts`: runs the planning and generation stages
- `src/emitter/project-emitter.ts`: writes generated files and compile metadata into `dist`

There is also a project example:

- `examples/todo-app/spec.config.js`
- `examples/todo-app/app.spec`

The old `demo/` directory remains as historical context, but the active product shape is now the CLI + `examples/` project model.

## Product Model

SpecOS should be understood as a spec-driven AI compiler, not as a one-shot code generator.

The working model is:

1. The user prepares a spec project directory.
2. The project may define compile behavior in `spec.config.js`.
3. The user initializes global API credentials with `spec init`.
4. The user runs `spec compile <projectDir>`.
5. SpecOS sends the merged spec context to an OpenAI-compatible HTTP endpoint.
6. SpecOS writes generated files into the configured `dist` directory.

## Configuration Model

Configuration is layered:

```text
CLI flags > project spec.config.js > global spec init config
```

Global config is intended for:

- `host`
- `auth`
- `model`
- `dist`
- `timeout`

Project config is intended for:

- `outDir`
- target stack
- AI generation parameters
- compile behavior like `clean` and `verbose`

Do not treat project config as the correct place for secrets unless that is explicitly intended by the user.

## Compile Scope In This MVP

The MVP compile pipeline is intentionally narrow:

- input: recursive `.spec` files inside one project directory
- planning: one streamed planning request to the model
- generation: one JSON file-generation request to the model
- output: generated frontend/backend files plus `.specos` metadata

The current fixed target stack is:

- React
- Ant Design
- TypeScript
- Python
- Flask
- MongoDB

## Mental Model For Codex

When editing this repository, assume:

- the CLI package is the main product, not the old demo files
- `examples/` should represent spec project inputs
- `dist` is compile output, not source
- compile should remain observable from the terminal
- comments in code should stay focused on the non-obvious parts
- the OpenAI HTTP integration should remain provider-compatible and not hard-code one vendor path beyond chat completions semantics

## Constraints

- Keep the implementation honest about MVP scope.
- Do not describe parser/validator/runtime subsystems as complete if they are not.
- Prefer TypeScript with Node.js `>= 18`.
- Keep the command model centered on `spec init` and `spec compile`.
- Preserve the project-config-based workflow around `spec.config.js`.
