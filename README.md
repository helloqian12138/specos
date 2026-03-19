# SpecOS

> Natural language in. Runnable system out.

SpecOS explores a development workflow where users describe a system in natural language, the system converts that intent into a structured spec, and the spec is then used to produce a runnable application.

This repository currently demonstrates that idea with a Todo example in the [`demo`](./demo) directory.

## What This Project Is

SpecOS is not just "AI generates code once".

The core idea is:

1. The user describes the system in natural language.
2. The system converts that description into a structured spec file.
3. The user can review and edit the spec directly.
4. The runtime/compiler layer uses the spec to produce a working system.

In short:

```text
Natural Language -> Spec -> runnable frontend + backend
```

That middle layer matters. The spec is the stable contract between user intent and system execution.

## Why The Spec Layer Exists

Natural language is flexible, but ambiguous.
Code is executable, but expensive to inspect and regenerate safely.
SpecOS uses a spec file as the editable, reviewable middle state.

That gives you:

- a format an LLM can generate
- a format a human can inspect and refine
- a format a runtime can execute deterministically

So the real product model is:

```text
Intent -> Spec -> System
```

not:

```text
Intent -> One-off generated code
```

## Demo Flow

The Todo demo shows the target workflow:

- [`demo/todo.spec`](/Users/lilingxia/WorkStation/specos/demo/todo.spec): the structured system definition
- [`demo/todo.jsx`](/Users/lilingxia/WorkStation/specos/demo/todo.jsx): generated or derived frontend implementation
- [`demo/todo.py`](/Users/lilingxia/WorkStation/specos/demo/todo.py): generated or derived backend implementation

The spec describes:

- domain entities
- actions and APIs
- page structure
- component behavior
- state loading rules

Example:

```spec
Action CreateTodo:
  API POST /api/v1/createTodo

  Input:
    title

  Do:
    insert Todo:
      title = input.title
      completed = false
```

This is the key point: users do not have to edit React or Flask first. They can edit the spec first.

## Desired User Experience

A complete SpecOS loop should look like this:

1. User input:

```text
Build a todo management system with search, create, and complete actions.
Use React + Ant Design for the frontend and Flask for the backend.
```

2. SpecOS generates `todo.spec`.
3. The user adjusts the spec if needed.
4. SpecOS builds or runs the application from the spec.

That means both of these are valid entry points:

- natural language from the user
- direct edits to the spec by the user

## Design Principles

- Spec is the source of truth.
- Natural language is the input, not the runtime contract.
- Users must be able to edit the spec directly.
- System behavior should be readable from the spec.
- Execution should be more deterministic than the natural-language step.

## Repository Layout

```text
specos/
├── demo/
│   ├── todo.spec
│   ├── todo.jsx
│   └── todo.py
├── docs/
│   └── ai-context.md
├── README.md
└── README.zh.md
```

## Who This Is For

SpecOS is for people exploring:

- AI-native software development
- spec-driven application generation
- human-editable intermediate representations
- systems where product intent should remain inspectable after generation

## Language

English (default) · Chinese: [`README.zh.md`](/Users/lilingxia/WorkStation/specos/README.zh.md)
