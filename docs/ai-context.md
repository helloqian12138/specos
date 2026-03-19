# SpecOS AI Context

## Overview

SpecOS is a project about building software from structured intent.

The target workflow is:

```text
Natural language -> spec file -> runnable system
```

In this repository, the spec is the most important intermediate artifact. A user may start with natural language, but the system should convert that input into a spec such as `todo.spec`. After that, the spec becomes the editable source of truth that can be reviewed, modified, validated, and turned into a working application.

This means SpecOS should be understood as a spec-driven system, not just a code generator.

## Current Repository State

The repository is currently an early demo centered on a Todo example.

Relevant files:

- `demo/todo.spec`: the structured system definition
- `demo/todo.jsx`: a frontend implementation derived from the spec
- `demo/todo.py`: a backend implementation derived from the spec

These files together demonstrate the intended pipeline:

```text
User intent -> Todo spec -> frontend/backend implementation
```

The repository does not yet contain a full parser, validator, or runtime engine. Those are implied future layers, not completed modules in the current codebase.

## Core Product Idea

SpecOS is built around the following model:

1. The user describes a system in natural language.
2. The system generates a structured spec.
3. The user can directly edit the spec.
4. The system produces a runnable application from the spec.

The spec layer exists because it solves three problems at once:

- it is easier for LLMs to generate than correct production code
- it is easier for humans to inspect and maintain than raw generated code
- it provides a more stable contract for deterministic execution

The most important project principle is:

```text
Spec is the source of truth.
```

Natural language is only an input mechanism.

## What A Spec Should Capture

A SpecOS spec should describe the system at an application level, not just at a UI widget level.

It should be able to express:

- system goal or domain
- entities and data shape
- actions and API contracts
- state and data-loading rules
- pages, sections, and components
- interaction behavior
- environment choices such as frontend/backend stack when relevant

From the Todo demo, examples of spec concepts include:

- `Entity Todo`
- `Action CreateTodo`
- `Action SearchTodos`
- `Action CompleteTodo`
- `Page TodoPage (/todos)`
- `Component CreateTodoModal`
- `State.todos`

## Mental Model For Codex

When working in this repository, assume:

- the spec is not documentation; it is the intended executable contract
- frontend and backend implementations should stay aligned with the spec
- changes should strengthen the pipeline from intent -> spec -> system
- repository language should describe the project as spec-driven, not as a generic DSL experiment

When adding or editing files, prefer changes that make the system easier to evolve in these stages:

1. natural language understanding
2. spec generation
3. spec validation
4. spec execution or compilation
5. runnable app output

## Design Principles

- Spec is the single source of truth.
- Users must be able to edit the spec directly.
- The spec should be readable by both humans and models.
- Behavior should be explicit in the spec instead of hidden in handwritten glue code.
- The step from spec to runnable system should be more deterministic than the step from natural language to spec.
- The system should preserve user intent in a structured, inspectable form.

## Constraints

- Do not treat the current repository as a finished framework.
- Do not describe nonexistent modules as if they already exist.
- Keep documentation aligned with the actual demo files in the repo.
- Avoid framing SpecOS as only a UI renderer or only a code generator.
- Prefer examples grounded in the Todo demo unless new examples are added.

## Guidance For Future Implementation

As the project evolves, the architecture will likely include:

- parser: natural language -> spec
- validator: spec syntax and semantic checks
- compiler or runtime: spec -> runnable system
- renderers or target generators for different stacks

Until those layers exist, documentation and code should remain honest about the repository's current scope: a concrete demonstration of the spec-driven workflow, with `todo.spec` as the key intermediate state.
