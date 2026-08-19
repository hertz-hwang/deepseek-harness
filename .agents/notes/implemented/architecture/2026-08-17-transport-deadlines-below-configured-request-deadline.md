# Agent Note: transport deadlines below the configured request deadline

Status: implemented

English | [中文](2026-08-17-transport-deadlines-below-configured-request-deadline.zh.md)

## Problem

A route on `@deepseek-ai/dsh-llm-pi-ai` pointed at a large local model could not complete a request over a big context, no matter how it was configured. The reported failure was `已重试模型请求 · 失败原因: terminated` followed by an identical retry, and the provider restarted its prefill from scratch on every attempt.

The route had `streamIdleTimeoutMs: 86400000` in `$DSH_HOME/settings.yaml`, and that setting was reaching the adapter correctly: `installSettingsSection` layers the user document over the cordis.yml entry config, and both LLM adapters re-resolve their profile once per `stream()` call. The setting was nonetheless irrelevant, because two shorter deadlines sat underneath it and fired first:

1. **undici's `bodyTimeout`/`headersTimeout`, 300000ms each.** Node's built-in `fetch` is undici, and nothing in this repository had ever installed a dispatcher, so both defaults applied to every model stream. A provider whose prefill runs past five minutes has its connection cut with `TypeError: terminated` (cause: `BodyTimeoutError`). `classifyPiAiError` maps that text to `TRANSPORT`, `TRANSPORT` is in the default retryable set, and the retry re-sends the same slow request.
2. **The provider SDK's own ten-minute abort.** `@earendil-works/pi-ai` forwards `timeoutMs` only when a profile sets it; absent, the OpenAI/Anthropic SDK applies its own default. A 1000-second prefill fails there too.

Both ceilings were invisible: neither appears in `docs/config-catalog.md`, and the only Harness-owned deadline a deployment could see and set was the one that never got to run.

## Decision

`streamIdleTimeoutMs` is the authoritative liveness deadline for a model stream, and the two deadlines below it are either owned explicitly or made to track it.

**`@deepseek-ai/dsh-http-timeout-policy`** (`packages/guard/http-timeout-policy`) owns undici's transport deadlines as validated config (`headersTimeoutMs`, `bodyTimeoutMs`), both defaulting to `0` — undici's documented "no deadline" value. It is mounted in `packages/bundle/base/cordis.patch.yml`, so every profile gets it. `apply` captures `getGlobalDispatcher()`, installs its own `Agent`, and on dispose restores the captured dispatcher and closes the Agent.

Defaulting both to disabled is safe because every `fetch` caller in the process already owns a deadline that knows what it waits for: the LLM adapters' `idleWatchdog` over `streamIdleTimeoutMs`, and `dsh-tool-web`'s cooperative 30s budgets enforced by `dsh-tool-call-timeout-policy`. Nothing depended on undici's 300000ms for liveness.

**`@deepseek-ai/dsh-llm-pi-ai`** now resolves `timeoutMs` to `streamIdleTimeoutMs` when a profile omits it, in `resolveProfiles` — the profile's existing defaulting step, not a `?? default` hidden at the call site — and `profileOptions` forwards it unconditionally. `ResolvedPiAiProviderProfile.timeoutMs` is a required `number`, and an explicitly configured value still wins.

`@deepseek-ai/dsh-llm-deepseek` needs no change: it issues a bare `fetch` with no SDK layer, so the global dispatcher covers it.

### The process-global mechanism, and why it is unavoidable

This is the only plugin in the repository that mutates process-global runtime state, which is the cost of a real constraint rather than a preference: pi-ai 0.82.1 constructs its SDK clients with `baseURL`/`defaultHeaders` only, and its `StreamOptions` exposes no `fetch`, `dispatcher`, or `httpAgent`. Nothing scoped to a request or a route can reach that stream's transport.

What makes a global dispatcher work at all is that Node's built-in `fetch` and the npm `undici` package share one dispatcher slot, `globalThis[Symbol.for('undici.globalDispatcher.1')]`. That is an undocumented Node internal. It was verified empirically on both ends of the supported engines range (22.19.0 and 26.5.0) before this design was chosen, and the package tests are what would catch a Node release that stopped sharing the slot — the symptom would be a silent return to the 300000ms defaults.

## Alternatives considered

**A per-request `dispatcher` on each adapter's `fetch` call.** Properly scoped, no global mutation, and it composes with per-route config — but it cannot work for `llm-pi-ai`, which is the adapter that has the problem, because pi-ai offers no injection point. It would have fixed only `llm-deepseek`, whose users had not reported the failure, and left a global dispatcher necessary anyway.

**A routing `Dispatcher` that relaxes deadlines only for configured LLM origins.** More precise than a blanket relax, and it keeps unrelated `fetch` callers on undici's defaults. Rejected as unjustified: no caller depends on those defaults, and the extra `origins` config would duplicate each route's `baseURL` with no owner keeping the two in sync. Recorded as deferred work in the package README, where the reintroduction condition is a caller that genuinely wants the shorter transport deadline.

**Upstreaming a `fetch` option to `@earendil-works/pi-ai`.** The correct long-term fix, and the one that would make this plugin unnecessary for the pi-ai path. Not taken here because it is an external dependency on someone else's release cadence, and the failure needed a fix in this repository.

**Documenting `NODE_OPTIONS="--import …"` instead of shipping a plugin.** Works, and is the mitigation for anyone on a build without this change, but it puts a load-bearing runtime setting outside the composition the harness owns — invisible to `cordis.yml`, `docs/config-catalog.md`, and every gate.

**Leaving `timeoutMs` optional and documenting it.** Rejected because the hidden ceiling was the whole defect: a deployment that set `streamIdleTimeoutMs` to 24 hours and read the README would still be aborted at ten minutes by a value it never chose.

## Consequences

A slow-prefill provider now completes instead of being retried into a loop, and the provider-side prefix cache survives across a turn rather than being rebuilt on every attempt. `streamIdleTimeoutMs` means what it says.

The cost is a process-global side effect in a harness whose composition is otherwise scoped, and a dependency on an undocumented Node internal. Two consequences follow from the blanket scope: a deployment that installs its own global dispatcher (an HTTP proxy agent) must not mount this plugin, since the `Agent` built here carries none of that configuration; and undici no longer bounds any `fetch` in the process, so a new caller that does not carry its own deadline can hang indefinitely. That obligation — every `fetch` caller owns a deadline — is stated in the package README.

`undici` becomes a direct dependency, pinned to the major that matches Node's internal copy. A wide skew between the npm Agent and Node's internal fetch would be a new failure mode; the tests exercise the real pair rather than a mock, so it surfaces as a test failure rather than in production.

## Testing

`packages/guard/http-timeout-policy/tests/http-timeout-policy.spec.ts` drives a real `node:http` server over real `fetch`, because undici's timer and the global dispatcher slot are not observable through a mock. It asserts the `terminated`/`BodyTimeoutError` pair a configured short deadline still produces (the exact failure this plugin exists to remove), that the defaults let a long body gap complete, that a configured headers deadline still applies, and that dispose restores the dispatcher captured at mount so an HMR reload stops governing `fetch`.

`packages/llm/llm-pi-ai/tests/sdk-options.spec.ts` asserts at the SDK boundary that `timeoutMs` is always forwarded, tracks `streamIdleTimeoutMs` by default, and yields to an explicit value.

No snapshot accompanies this change: it alters no model-visible text, tool schema, or result — only how long a transport waits before failing a request.
