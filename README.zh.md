# SpecOS

> 输入结构化 spec，输出可运行项目。

SpecOS 现在的 MVP 形态是一个基于 TypeScript 的 CLI 工具，用来把一个 spec 工程目录通过 AI 编译成可运行的项目骨架。

当前版本特性：

- Node.js `>= 18`
- npm 风格 CLI 包
- 支持项目内 `spec.config.js`
- 通过 `spec init` 初始化全局 API 配置
- 通过 `spec compile <projectDir>` 执行 AI 编译
- 固定目标技术栈：`React + Ant Design + TypeScript + Flask + MongoDB`

## 产品模型

```text
spec 工程目录 -> AI compile -> 前后端可运行项目
```

source of truth 是 spec 工程目录，不是 `dist` 里的生成代码。

## 命令

初始化全局 API 配置：

```bash
spec init --host https://api.openai.com/v1 --auth sk-...
```

或者从文件加载：

```bash
spec init --config ./spec.global.json
```

初始化一个项目模板：

```bash
spec init --project ./examples/my-app
```

编译一个 spec 工程：

```bash
spec compile ./examples/todo-app
```

编译时覆盖输出目录或模型：

```bash
spec compile ./examples/todo-app --outDir ./dist --model gpt-4o-mini
```

打开 debug 输出：

```bash
spec compile ./examples/todo-app --debug
```

## 项目配置

每个 spec 工程都可以有自己的 `spec.config.js`：

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

配置优先级：

```text
CLI 参数 > 项目 spec.config.js > 全局 spec init 配置
```

`auth` 应该保留在全局配置里，不建议放进项目目录。

## 示例目录

```text
examples/todo-app/
├── spec.config.js
└── app.spec
```

MVP 当前会递归扫描目录中的 `.spec` 文件，并把它们合并成一个 AI compile 上下文。

## 编译产物

生成文件会写入配置的 `outDir`。

同时会额外写入：

```text
dist/.specos/
├── compile-log.json
├── file-manifest.json
└── prompt-trace.json
```

## 本地开发

安装依赖并构建：

```bash
npm install
npm run build
```

本地运行编译后的 CLI：

```bash
node ./lib/index.js compile ./examples/todo-app
```

## 仓库结构

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

English: [`README.md`](./README.md)
