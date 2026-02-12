# Renderify 框架设计总览（v0.2）

## 1. 产品目标

Renderify 目标是做“受控的全动态 runtime UI”：

- 输入变化后直接 runtime 输出 UI（不要求每次都构建发布）
- 动态执行必须受策略约束，而不是无限制执行
- JSPM/SystemJS 作为默认运行时模块层

## 2. 北极星链路

1. Prompt + Context
2. LLM 解释
3. 产出 RuntimePlan（IR）
4. Security Policy 校验
5. Runtime 执行（可按需加载模块）
6. Renderer 输出 UI

## 3. 分层架构

### Contracts Layer

- `@renderify/ir`
- 定义 plan/node/state/event/action/capabilities/result 合同
- 协议字段：`specVersion` + `moduleManifest`

### Control Layer

- `@renderify/security`
- 校验：
  - 节点深度/数量
  - 禁用标签
  - 模块白名单
  - 网络主机白名单
  - runtime quota 请求上限
  - profile 档位（strict/balanced/relaxed）

### Execution Layer

- `@renderify/runtime`
- 负责：
  - 节点递归解析
  - 组件模块加载与执行
  - 资源预算控制（imports/time/component invocations）
  - `executionProfile`（`standard` / `isolated-vm` / `sandbox-worker` / `sandbox-iframe`）
  - 模块清单约束（manifest-aware resolution）
  - 浏览器 source 沙箱执行（Worker/iframe）
  - 隔离不可用默认 fail-closed（可配置）

- `@renderify/runtime`
- 默认 loader：
  - `importMap` 支持
  - JSPM CDN 解析
  - `System.import` / dynamic import 双路径

### Experience Layer

- `@renderify/runtime`
- 提供一行嵌入 API（`renderPlanInBrowser`）和浏览器挂载能力

- `@renderify/cli` playground
- 浏览器实时调试面板（prompt/plan/stream/probe）

### Orchestration Layer

- `@renderify/core`
- 编排全流程并提供插件 hook：
  - `beforeLLM` / `afterLLM`
  - `beforeCodeGen` / `afterCodeGen`
  - `beforePolicyCheck` / `afterPolicyCheck`
  - `beforeRuntime` / `afterRuntime`
  - `beforeRender` / `afterRender`

## 4. 关键设计决策

1. “无限制 runtime”不作为目标，采用“受控 runtime”。
2. IR 先行，禁止直接执行原始 LLM 文本。
3. Runtime 与 Loader 解耦，JSPM 是默认而非唯一实现。
4. 每次执行都输出可观测诊断并支持流式预览。

## 5. 当前边界

已完成：

- 核心 runtime 渲染链路
- 核心 3 包主路径：`@renderify/ir` + `@renderify/runtime` + `@renderify/security`
- prompt 流式预览（renderPromptStream）
- CLI + playground 实时链路
- TSX/JSX 文本输出到 runtime source 的直接执行链路（Babel + JSPM）
- 浏览器 source 沙箱基线（Worker/iframe）

未完成：

- 沙箱进一步工业级加固（CSP、权限裁剪、跨域策略与观测）
- 本地模型 provider 与生产级可靠性策略（重试/退避/熔断）
