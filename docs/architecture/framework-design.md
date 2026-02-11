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
7. Audit 记录 + Rollback / Replay

## 3. 分层架构

### Contracts Layer

- `@renderify/ir`
- 定义 plan/node/state/event/action/capabilities/result 合同

### Control Layer

- `@renderify/security`
- 校验：
  - 节点深度/数量
  - 禁用标签
  - 模块白名单
  - 网络主机白名单
  - transition/action 限额
  - runtime quota 请求上限
  - profile 档位（strict/balanced/relaxed）

- `@renderify/core` tenant governor
- 运行治理：
  - 每租户分钟级执行配额
  - 每租户并发执行上限
  - 超限触发 throttled 审计事件

### Execution Layer

- `@renderify/runtime`
- 负责：
  - 节点递归解析
  - 组件模块加载与执行
  - 状态迁移（event -> actions -> new state）
  - 资源预算控制（imports/time/component invocations）
  - `executionProfile`（`standard` / `isolated-vm`）

- `@renderify/runtime-jspm`
- 默认 loader：
  - `importMap` 支持
  - JSPM CDN 解析
  - `System.import` / dynamic import 双路径

### Experience Layer

- `@renderify/ui`
- 输出 HTML 并可挂载 DOM

- `@renderify/cli` playground
- 浏览器实时调试面板（prompt/plan/event/state/history）

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
4. 每次执行都可审计，可回放，可回滚。

## 5. 当前边界

已完成：

- 状态化 runtime 迁移
- rollback/replay
- CLI + playground 实时链路
- TSX/JSX 文本输出到 runtime source 的直接执行链路（Babel + JSPM）

未完成：

- 生产级沙箱隔离边界（Worker/VM）
- 真正多租户策略模板与治理模型
- 更多 LLM provider 与生产级可靠性策略（重试/退避/熔断）
