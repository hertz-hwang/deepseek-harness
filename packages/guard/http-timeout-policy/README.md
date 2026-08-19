# dsh-http-timeout-policy

English | [中文](README.zh.md)

Process-global HTTP transport deadlines for Node's built-in `fetch`. Node's `fetch` is undici, and undici's default `headersTimeout` and `bodyTimeout` are 300000ms each. Those two deadlines are invisible to Harness configuration and fire before any Harness-owned deadline, so this plugin owns them explicitly and defaults both to disabled — leaving liveness to the caller that knows what it is waiting for.

## The failure this removes

A model provider that needs longer than five minutes to produce its first response byte — a large local model running a long prefill over a big context — has its connection cut by undici, not by the harness. The resulting error is a bare `TypeError: terminated` whose `cause` is undici's `BodyTimeoutError`. `@deepseek-ai/dsh-llm-pi-ai` classifies that text as a `TRANSPORT` failure, `TRANSPORT` is in the default retryable set (`@deepseek-ai/dsh-llm`'s `retryPolicy`), and the retry re-sends the same slow request — so the route never completes and the provider repeats the same prefill on every attempt.

A route's configured `streamIdleTimeoutMs` cannot prevent this on its own: it is a longer deadline sitting above a shorter one that fires first.

## Plugin (namespace: `http-timeout-policy`)

A function/namespace plugin (`name` / `Config` / `apply`), not a service. It registers no tool, prompt, or session event.

```yaml
- id: http-timeout-policy
  name: '@deepseek-ai/dsh-http-timeout-policy'
  config:
    headersTimeoutMs: 0
    bodyTimeoutMs: 0
```

| Field | Default | Meaning |
|---|---|---|
| `headersTimeoutMs` | `0` | Milliseconds undici waits for response headers. `0` disables the deadline. |
| `bodyTimeoutMs` | `0` | Milliseconds undici waits between response body chunks. `0` disables the deadline. |

Each value must be an integer between `0` and `2147483647` (the largest delay Node schedules without clamping); anything else fails at mount. Unlike `@deepseek-ai/dsh-timeout`, where zero is explicitly **not** a disable sentinel, `0` here is undici's own documented "no deadline" value — that difference is the only reason this package validates its own fields instead of reusing the shared helper.

`connectTimeout` is deliberately not exposed: it bounds TCP connection establishment, which is unrelated to a slow response and whose 10s default is appropriate.

### Why the defaults disable both deadlines

Every `fetch` caller in the process already carries a deadline that knows what it is waiting for:

- `@deepseek-ai/dsh-llm-pi-ai` and `@deepseek-ai/dsh-llm-deepseek` bound a stalled provider with the route's `streamIdleTimeoutMs` through `idleWatchdog`, which aborts the request's signal.
- `@deepseek-ai/dsh-tool-web` attaches a cooperative per-call budget (30s by default) that `@deepseek-ai/dsh-tool-call-timeout-policy` enforces.

No caller depends on undici's 300000ms defaults for liveness, so removing them loses no protection while making the configured deadline authoritative.

### Process-global scope

This is the only plugin in the repository that mutates process-global runtime state. It does so because the alternative does not exist: `@earendil-works/pi-ai` builds its OpenAI and Anthropic SDK clients without any `fetch`, `dispatcher`, or `httpAgent` option, so a per-request dispatcher cannot reach the LLM stream at all.

The mechanism is that Node's built-in `fetch` and the npm `undici` package share one dispatcher slot, `globalThis[Symbol.for('undici.globalDispatcher.1')]`. `apply` captures `getGlobalDispatcher()`, installs its own `Agent`, and on dispose restores the captured dispatcher and closes the Agent it created, so an HMR reload leaks no connection pool.

## Model Experience

None, as the plugin contributes no prompt, tool, or session event; it changes only how long a transport waits before failing a request.

#### KV Cache effect

No direct effect, and one indirect benefit: a provider request that previously died mid-prefill and was re-sent now completes, so the provider-side prefix cache is not rebuilt from scratch on every attempt.

## Known Limitations and Deferred Work

- **Whole-process scope, not per-origin** — one dispatcher governs every `fetch` in the process. A routing `Dispatcher` that relaxed deadlines only for configured LLM origins would be more precise; it is deliberately not built, because no current caller needs undici's defaults and the extra configuration would duplicate each route's `baseURL`.
- **Replaces the global dispatcher wholesale** — a deployment that installs its own global dispatcher (an HTTP proxy agent, say) must not mount this plugin, since the `Agent` built here carries none of that dispatcher's configuration.
- **Depends on an undocumented Node internal** — the shared `undici.globalDispatcher.1` symbol is what makes an npm-`undici` dispatcher govern the built-in `fetch`. It is verified by the package tests across the supported engines range, and a Node release that stopped sharing the slot would silently restore the 300000ms defaults; the tests are what would catch it.
