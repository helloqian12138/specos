# SpecOS

> 输入自然语言，输出可运行系统。

SpecOS 想做的是这样一条链路：用户先用自然语言描述需求，系统把需求转换成 `todo.spec` 这样的结构化规格文件，用户可以继续手工修改这个 spec，最后再由运行时或编译层把 spec 变成一个真正可运行的系统。

当前仓库用 [`demo`](./demo) 目录里的 Todo 示例来说明这件事。

## 这个项目到底是什么

SpecOS 不是“让 AI 一次性吐出代码”。

它的核心模型是：

1. 用户用自然语言表达想要的系统。
2. 系统先生成一个结构化 spec。
3. 用户可以直接检查和维护这个 spec。
4. 系统再根据 spec 生成或驱动最终应用。

也就是：

```text
自然语言 -> 结构化系统描述 -> 可运行前后端系统
```

这里最重要的是中间这层 spec。它不是临时产物，而是用户意图和系统执行之间的正式契约。

## 为什么一定要有 Spec 这一层

自然语言足够灵活，但不够稳定。
代码可以执行，但很难作为用户和系统之间长期维护的中间态。

SpecOS 的思路是把 spec 作为中间层，原因有三个：

- LLM 容易生成
- 人类容易阅读和修改
- 运行时更容易做确定性执行

所以 SpecOS 的目标不是：

```text
需求 -> 一次性生成代码
```

而是：

```text
需求 -> Spec -> 系统
```

## 怎么理解

Todo 示例已经把这条链路拆成了三个部分：

- [`demo/todo.spec`](/Users/lilingxia/WorkStation/specos/demo/todo.spec)：系统规格，描述实体、动作、页面、状态
- [`demo/todo.jsx`](/Users/lilingxia/WorkStation/specos/demo/todo.jsx)：前端实现，对应 React + Ant Design
- [`demo/todo.py`](/Users/lilingxia/WorkStation/specos/demo/todo.py)：后端实现，对应 Flask API

其中 `todo.spec` 不是注释，也不是伪文档，而是这个系统最重要的中间态。比如：

```spec
Action CompleteTodo:
  API POST /api/v1/completeTodo

  Input:
    id

  Do:
    update Todo:
      where id = input.id
      set completed = true
```

这段 spec 已经明确表达了：

- API 路径是什么
- 输入是什么
- 对哪一个实体做什么更新
- 返回什么结果

也就是说，用户未来既可以通过自然语言生成它，也可以直接手工修改它。

## 用户心智

一个完整流程应该是：

1. 用户输入一句自然语言需求：

```text
帮我做一个 Todo 管理系统，支持新增、搜索、完成，前端用 React + Ant Design，后端用 Flask。
```

2. 系统生成 `todo.spec`
3. 用户检查并修改 `todo.spec`
4. 系统根据 `todo.spec` 生成或运行最终应用

所以这个系统应该同时支持两种入口：

- 从自然语言开始
- 从已有 spec 开始

## 设计原则

- Spec 是唯一事实来源
- 自然语言只是输入方式，不是最终执行契约
- 用户必须可以直接编辑 spec
- 系统行为必须尽量从 spec 中读出来
- spec 到系统的过程应该比自然语言到 spec 更确定


## 仓库结构

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

## Language

English: [`README.md`](./README.md)
