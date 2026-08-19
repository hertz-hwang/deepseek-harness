# dsh-http-timeout-policy

[English](README.md) | 中文

为 Node 内置 `fetch` 设置进程级 HTTP 传输截止时间。Node 的 `fetch` 就是 undici，而 undici 的 `headersTimeout` 与 `bodyTimeout` 默认各为 300000ms。这两个截止时间对 Harness 配置不可见，且会先于任何 Harness 自有的截止时间触发，因此本插件显式接管它们，并将两者默认置为关闭 —— 把存活判定交给真正知道自己在等什么的调用方。

## 它消除的故障

当模型服务端产出首个响应字节需要超过五分钟时（例如大型本地模型在大上下文上执行长 prefill），切断连接的是 undici，而非 harness。由此产生的错误是一个裸的 `TypeError: terminated`，其 `cause` 为 undici 的 `BodyTimeoutError`。`@deepseek-ai/dsh-llm-pi-ai` 将该文本归类为 `TRANSPORT` 失败，而 `TRANSPORT` 位于默认可重试集合中（`@deepseek-ai/dsh-llm` 的 `retryPolicy`），于是重试会重新发送同一个慢请求 —— 该路由因此永远无法完成，且服务端在每次尝试时都重复同一段 prefill。

路由上配置的 `streamIdleTimeoutMs` 无法单独阻止这一点：它是一个更长的截止时间，却位于一个更短、且会先触发的截止时间之上。

## 插件（命名空间：`http-timeout-policy`）

它是函数／命名空间插件（`name`／`Config`／`apply`），而非服务。它不注册工具、提示词或 Session 事件。

```yaml
- id: http-timeout-policy
  name: '@deepseek-ai/dsh-http-timeout-policy'
  config:
    headersTimeoutMs: 0
    bodyTimeoutMs: 0
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `headersTimeoutMs` | `0` | undici 等待响应头的毫秒数。`0` 表示关闭该截止时间。 |
| `bodyTimeoutMs` | `0` | undici 在两个响应体分片之间等待的毫秒数。`0` 表示关闭该截止时间。 |

两个值都必须是介于 `0` 与 `2147483647`（Node 不做钳制即可调度的最大延迟）之间的整数；其它取值在挂载时失败。与 `@deepseek-ai/dsh-timeout` 不同 —— 在那里零明确**不是**关闭哨兵值 —— 此处的 `0` 是 undici 自身文档规定的「无截止时间」取值；这一差异是本包自行校验字段而非复用共享辅助函数的唯一原因。

`connectTimeout` 被有意排除在外：它约束的是 TCP 连接建立，与响应慢无关，其 10s 默认值是恰当的。

### 为何默认关闭两个截止时间

进程内每个 `fetch` 调用方都已带有一个知道自己在等什么的截止时间：

- `@deepseek-ai/dsh-llm-pi-ai` 与 `@deepseek-ai/dsh-llm-deepseek` 通过 `idleWatchdog` 以路由的 `streamIdleTimeoutMs` 约束停滞的服务端，该看门狗会中止请求的 signal。
- `@deepseek-ai/dsh-tool-web` 附加每次调用的协作式预算（默认 30s），由 `@deepseek-ai/dsh-tool-call-timeout-policy` 强制执行。

没有调用方依赖 undici 的 300000ms 默认值来保证存活，因此移除它们不损失任何保护，同时让被配置的截止时间成为权威。

### 进程级作用范围

这是仓库中唯一改动进程级运行时状态的插件。它这样做是因为不存在替代方案：`@earendil-works/pi-ai` 构造其 OpenAI 与 Anthropic SDK 客户端时不带任何 `fetch`、`dispatcher` 或 `httpAgent` 选项，因此按请求设置的 dispatcher 根本无法触及 LLM 流。

其机制是：Node 内置 `fetch` 与 npm `undici` 包共享同一个 dispatcher 槽位 `globalThis[Symbol.for('undici.globalDispatcher.1')]`。`apply` 会捕获 `getGlobalDispatcher()`，装入自己的 `Agent`，并在 dispose 时恢复所捕获的 dispatcher 并关闭自己创建的 Agent，因此 HMR 重载不泄漏连接池。

## Model Experience

无，因为该插件不贡献提示词、工具或 Session 事件；它只改变传输层在使请求失败前等待多久。

#### KV Cache 影响

无直接影响，另有一项间接收益：此前在 prefill 中途死亡并被重发的服务端请求现在能够完成，因此服务端的前缀缓存不会在每次尝试时从零重建。

## 已知限制与待办

- **作用于整个进程，而非按 origin 区分** —— 一个 dispatcher 治理进程内每个 `fetch`。仅对配置的 LLM origin 放宽截止时间的路由型 `Dispatcher` 会更精确；该方案被有意搁置，因为当前没有调用方需要 undici 的默认值，而额外配置会与各路由的 `baseURL` 重复。
- **整体替换全局 dispatcher** —— 自行装入全局 dispatcher 的部署（例如 HTTP 代理 agent）不得挂载本插件，因为此处构造的 `Agent` 不携带那个 dispatcher 的任何配置。
- **依赖一个未公开的 Node 内部细节** —— 共享的 `undici.globalDispatcher.1` 符号正是 npm-`undici` dispatcher 得以治理内置 `fetch` 的原因。本包测试在受支持的 engines 范围内验证了它；某个停止共享该槽位的 Node 版本会静默恢复 300000ms 默认值，而测试正是能够捕获此情况的手段。
