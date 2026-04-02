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

SpecOS 更适合让 `app.spec` 只描述三类东西：

- 领域模型
- 业务能力
- 页面意图和用户可见结构

产品意图应该放在 `app.spec`，技术栈和运行时细节应该放在 `spec.config.js` 和独立的 stack profile 里。

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

通过 `spec init --project` 创建的新项目会自带隐藏的 `.specos/` 脚手架。`frontend/package.json`、`frontend/index.html`、`frontend/tsconfig.json`、`frontend/vite.config.ts`、`backend/requirements.txt`、`.env.example` 这类运行时环境文件会基于这层脚手架产出，而不是继续让模型生成。

运行已生成项目：

```bash
spec run ./examples/todo-app
```

运行前先安装依赖：

```bash
spec run ./examples/todo-app --install
```

用 dev/watch 模式运行：

```bash
spec run ./examples/todo-app --dev
```

## 项目配置

每个 spec 工程都可以有自己的 `spec.config.js`：

```js
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
```

然后把更细的技术栈配置放到 `stack.config.js`：

```js
export default {
  frontend: {
    framework: "react",
    frameworkVersion: "18.3.1",
    ui: "antd",
    uiVersion: "5.24.7",
    language: "typescript",
    languageVersion: "5.8.2",
    nodeVersion: "20",
    host: "0.0.0.0",
    port: 3000,
    apiBasePath: "/api",
    proxyTarget: "http://127.0.0.1:5000"
  },
  backend: {
    framework: "flask",
    frameworkVersion: "3.0",
    language: "python",
    languageVersion: "3.11",
    host: "127.0.0.1",
    port: 5000,
    entry: "app.py"
  },
  data: {
    engine: "mongodb",
    engineVersion: "7",
    uri: "mongodb://127.0.0.1:27017/specos"
  }
}
```

配置优先级：

```text
CLI 参数 > 项目 spec.config.js > 全局 spec init 配置
```

`auth` 应该保留在全局配置里，不建议放进项目目录。

stack profile 适合承载这些内容：

- 框架和库名称
- 具体依赖版本
- 前后端 host 和 port
- API base path 和前端代理目标
- 数据库 URI 和库名
- 后端入口文件和 CORS 白名单

## Spec 结构建议

推荐的顶层 block：

- `App`：一句话说明产品
- `Goal`：系统目标
- `Entity`：领域对象和字段约束
- `Action`：业务动作、输入、结果、规则
- `Page`：页面路由和直观页面说明
- `Component`：可复用弹窗或表单
- `State`：页面级数据源绑定

推荐的页面 section：

- `Summary`
- `Query`
- `Load`
- `Header`
- `Filters`
- `Content`
- `Empty`
- `Footer`

页面应该写成“页面说明书”，不要写成 React 代码或组件树配置。

推荐写法：

- `Search -> reload todos`
- `Add Todo -> open CreateTodoModal`
- `Complete -> CompleteTodo(id = row.id) -> reload todos`

不推荐：

- 在 `app.spec` 里写框架名
- 把 API URL 当成产品规格主体
- 写 CSS 或布局实现细节
- 写 hook、dispatch、组件库专有词汇

## 示例项目

```text
examples/todo-app/
├── spec.config.js
├── stack.config.js
└── app.spec
```

MVP 当前会递归扫描目录中的 `.spec` 文件，并把它们合并成一个 AI compile 上下文。

示例：

```spec
App: Todo Manager

Goal:
  Manage personal todos with a clear list page and a quick create flow.

---

Entity Todo:
  id: string (primary)
  title: string (required, maxLength=100)
  completed: boolean (default=false)

---

Action CreateTodo:
  Input:
    title
  Do:
    insert Todo:
      title = input.title
      completed = false
  Return:
    success
    id

---

Action SearchTodos:
  Input:
    searchKey = "" (optional)
    page
    pageSize
  Do:
    query Todo:
      where completed = false
      and title contains searchKey
    paginate by page, pageSize
  Return:
    data: Todo[]
    total

---

Page TodoPage (/todos):
  Summary:
    List open todos, search them, and create new ones.

  Query:
    searchKey = ""
    page = 1
    pageSize = 10

  Load:
    todos = SearchTodos(searchKey, page, pageSize)

  Header:
    text("Todo Manager", align=center)
    button("Add Todo", primary):
      onClick:
        openModal CreateTodoModal

  Filters:
    input(searchKey)
    button("Search"):
      onClick:
        dispatch SearchTodos
        refresh todos

  Content:
    table(todos):
      columns:
        id
        title
        action:
          button("Complete"):
            onClick:
              dispatch CompleteTodo(id = row.id)
              refresh todos

---

Component CreateTodoModal:
  modal("Create Todo"):
    form:
      field title (input, required)
    onSubmit:
      dispatch CreateTodo(title = form.title)
      closeModal
      refresh todos

---

State:
  todos:
    source: SearchTodos
```

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
│   ├── todo-app/
│   └── users/
├── src/
├── docs/
├── demo/
├── README.md
└── README.zh.md
```

## Language

English: [`README.md`](./README.md)
