# Agent Note：位于被配置请求截止时间之下的传输截止时间

Status: implemented

[English](2026-08-17-transport-deadlines-below-configured-request-deadline.md) | 中文

## 问题

`@deepseek-ai/dsh-llm-pi-ai` 上一条指向大型本地模型的路由，在大上下文上无论如何配置都无法完成请求。报出的故障是 `已重试模型请求 · 失败原因: terminated`，随后是一次完全相同的重试，而服务端在每次尝试时都从零重新开始 prefill。

该路由已在 `$DSH_HOME/settings.yaml` 中设置 `streamIdleTimeoutMs: 86400000`，且该设置确实抵达了 adapter：`installSettingsSection` 把用户文档叠加在 cordis.yml 条目配置之上，两个 LLM adapter 都在每次 `stream()` 调用时重新解析其 profile。尽管如此，该设置仍然无关紧要，因为它下面有两个更短的截止时间会先触发：

1. **undici 的 `bodyTimeout`／`headersTimeout`，各为 300000ms。** Node 内置 `fetch` 就是 undici，而本仓库从未装入过 dispatcher，因此这两个默认值适用于每个模型流。prefill 超过五分钟的服务端会被切断连接，报出 `TypeError: terminated`（cause 为 `BodyTimeoutError`）。`classifyPiAiError` 将该文本映射为 `TRANSPORT`，`TRANSPORT` 位于默认可重试集合中，于是重试重新发送同一个慢请求。
2. **提供方 SDK 自带的十分钟中止。** `@earendil-works/pi-ai` 仅在 profile 设置了 `timeoutMs` 时才转发它；未设置时，OpenAI／Anthropic SDK 套用自己的默认值。1000 秒的 prefill 在那里同样失败。

两个上限都是不可见的：它们都不出现在 `docs/config-catalog.md` 中，而部署唯一能看到并设置的 Harness 自有截止时间，恰恰是永远轮不到运行的那一个。

## 决策

`streamIdleTimeoutMs` 是模型流权威的存活截止时间，而位于其下的两个截止时间要么被显式接管，要么被改为跟随它。

**`@deepseek-ai/dsh-http-timeout-policy`**（`packages/guard/http-timeout-policy`）以受校验配置（`headersTimeoutMs`、`bodyTimeoutMs`）接管 undici 的传输截止时间，两者均默认为 `0` —— undici 文档规定的「无截止时间」取值。它挂载于 `packages/bundle/base/cordis.patch.yml`，因此每个 profile 都会获得它。`apply` 捕获 `getGlobalDispatcher()`，装入自己的 `Agent`，并在 dispose 时恢复所捕获的 dispatcher 并关闭该 Agent。

两者默认关闭是安全的，因为进程内每个 `fetch` 调用方都已拥有一个知道自己在等什么的截止时间：LLM adapter 基于 `streamIdleTimeoutMs` 的 `idleWatchdog`，以及 `dsh-tool-web` 由 `dsh-tool-call-timeout-policy` 强制执行的协作式 30s 预算。没有任何调用方依赖 undici 的 300000ms 来保证存活。

**`@deepseek-ai/dsh-llm-pi-ai`** 现在在 profile 省略 `timeoutMs` 时，于 `resolveProfiles` 中将其解析为 `streamIdleTimeoutMs` —— 位于 profile 已有的默认值步骤中，而非藏在调用点的 `?? default` —— 且 `profileOptions` 无条件转发它。`ResolvedPiAiProviderProfile.timeoutMs` 是必填 `number`，显式配置的值仍然优先。

`@deepseek-ai/dsh-llm-deepseek` 无需改动：它发起裸 `fetch`，没有 SDK 层，因此全局 dispatcher 已覆盖它。

### 进程级机制，以及为何它不可避免

这是仓库中唯一改动进程级运行时状态的插件；这是一个真实约束的代价，而非偏好：pi-ai 0.82.1 构造其 SDK 客户端时只带 `baseURL`／`defaultHeaders`，其 `StreamOptions` 不暴露 `fetch`、`dispatcher` 或 `httpAgent`。任何限定到请求或路由的方案都无法触及该流的传输层。

使全局 dispatcher 得以生效的前提是：Node 内置 `fetch` 与 npm `undici` 包共享同一个 dispatcher 槽位 `globalThis[Symbol.for('undici.globalDispatcher.1')]`。这是一个未公开的 Node 内部细节。在选定本设计之前，它已在受支持 engines 范围的两端（22.19.0 与 26.5.0）经实测验证；若某个 Node 版本停止共享该槽位，本包测试正是能够捕获它的手段 —— 症状会是静默恢复 300000ms 默认值。

## 备选方案

**在各 adapter 的 `fetch` 调用上按请求设置 `dispatcher`。** 作用范围恰当、无全局改动，且能与按路由的配置组合 —— 但它对 `llm-pi-ai` 无法生效，而后者正是出问题的 adapter，因为 pi-ai 不提供注入点。它只会修好 `llm-deepseek`（其用户并未报告该故障），而全局 dispatcher 无论如何仍然必要。

**仅对配置的 LLM origin 放宽截止时间的路由型 `Dispatcher`。** 比一揽子放宽更精确，且让无关的 `fetch` 调用方保留 undici 默认值。因缺乏依据而否决：没有调用方依赖那些默认值，而额外的 `origins` 配置会与各路由的 `baseURL` 重复，且无人负责保持两者同步。它作为待办记录在包 README 中，其重新引入条件是出现一个确实想要更短传输截止时间的调用方。

**向 `@earendil-works/pi-ai` 上游添加 `fetch` 选项。** 这是正确的长期修复，也会让本插件对 pi-ai 路径变得不必要。此处未采用，因为它是外部依赖、受制于他人的发布节奏，而该故障需要在本仓库内修复。

**只在文档中说明 `NODE_OPTIONS="--import …"`，而不发布插件。** 可行，也是尚未获得本改动的构建的缓解手段，但它把一个承重的运行时设置放在 harness 所拥有的组合之外 —— 对 `cordis.yml`、`docs/config-catalog.md` 和每一道门禁都不可见。

**保持 `timeoutMs` 可选并写入文档。** 否决，因为隐藏的上限正是缺陷本身：把 `streamIdleTimeoutMs` 设为 24 小时并读过 README 的部署，仍会被一个自己从未选择的值在十分钟处中止。

## 影响

慢 prefill 的服务端现在能够完成，而不再被重试拖入循环，且服务端前缀缓存在一个回合内得以存续，而非每次尝试都重建。`streamIdleTimeoutMs` 名副其实。

代价是在一个组合本应受限定作用范围的 harness 中引入了进程级副作用，以及对一个未公开 Node 内部细节的依赖。一揽子作用范围带来两个后果：自行装入全局 dispatcher 的部署（HTTP 代理 agent）不得挂载本插件，因为此处构造的 `Agent` 不携带那份配置；以及 undici 不再约束进程内任何 `fetch`，因此一个不自带截止时间的新调用方可能无限挂起。该义务 —— 每个 `fetch` 调用方各自拥有一个截止时间 —— 已写入包 README。

`undici` 成为直接依赖，固定在与 Node 内部副本相匹配的大版本。npm Agent 与 Node 内置 fetch 之间的大幅版本偏移会是一个新的失效模式；测试演练的是真实的两者组合而非 mock，因此它会以测试失败而非线上故障的形式出现。

## 测试

`packages/guard/http-timeout-policy/tests/http-timeout-policy.spec.ts` 以真实 `fetch` 驱动真实 `node:http` 服务器，因为 undici 的定时器与全局 dispatcher 槽位无法通过 mock 观察。它断言：配置一个较短截止时间时仍会产生 `terminated`／`BodyTimeoutError` 组合（本插件所要消除的确切故障）；默认值让长响应体间隔得以完成；配置的响应头截止时间仍然适用；以及 dispose 恢复挂载时捕获的 dispatcher，从而使 HMR 重载后不再治理 `fetch`。

`packages/llm/llm-pi-ai/tests/sdk-options.spec.ts` 在 SDK 边界断言 `timeoutMs` 始终被转发、默认跟随 `streamIdleTimeoutMs`，并让位于显式值。

本改动不附带 snapshot：它不改变任何面向模型的文本、工具 schema 或结果 —— 只改变传输层在使请求失败前等待多久。
