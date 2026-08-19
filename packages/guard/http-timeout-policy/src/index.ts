/**
 * Process-global HTTP transport deadlines for Node's built-in `fetch`.
 *
 * Node's `fetch` is undici, and undici's default `headersTimeout`/`bodyTimeout`
 * are 300000ms each. Those defaults are invisible to configuration and fire
 * before any harness-owned deadline: a model stream whose provider needs longer
 * than five minutes to produce its first byte (a large local model's prefill)
 * dies as `TypeError: terminated` with an undici `BodyTimeoutError` cause, which
 * classifies as a retryable `TRANSPORT` failure and restarts the same slow
 * request. This plugin replaces the global dispatcher so those two transport
 * deadlines stop preempting the per-request deadlines the harness already owns
 * (`streamIdleTimeoutMs` on an LLM route, `ToolDefinition.timeoutMs` on a tool).
 *
 * @module @deepseek-ai/dsh-http-timeout-policy
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'http-timeout-policy'

/**
 * Both defaults disable undici's own timer. Liveness stays with the caller that
 * knows what it is waiting for: `@deepseek-ai/dsh-llm-pi-ai` and
 * `@deepseek-ai/dsh-llm-deepseek` bound a stalled provider with
 * `streamIdleTimeoutMs`, and `@deepseek-ai/dsh-tool-web` attaches a cooperative
 * budget enforced by `@deepseek-ai/dsh-tool-call-timeout-policy`. A transport
 * deadline shorter than those turns a slow-but-healthy response into a failure.
 */
export const DEFAULT_HEADERS_TIMEOUT_MS = 0

/** See {@link DEFAULT_HEADERS_TIMEOUT_MS}; the body deadline disables for the same reason. */
export const DEFAULT_BODY_TIMEOUT_MS = 0

/** Plugin config: the two undici transport deadlines this plugin owns. */
export interface Config {
  /**
   * Milliseconds undici waits for response headers before aborting the request.
   * `0` disables the deadline. Defaults to 0.
   */
  headersTimeoutMs?: number
  /**
   * Milliseconds undici waits between response body chunks before aborting the
   * request. `0` disables the deadline. Defaults to 0.
   */
  bodyTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  headersTimeoutMs: z.number().default(DEFAULT_HEADERS_TIMEOUT_MS),
  bodyTimeoutMs: z.number().default(DEFAULT_BODY_TIMEOUT_MS),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/**
 * Largest delay Node schedules without clamping it to one millisecond; undici
 * arms an ordinary timer, so a larger value would silently fire immediately.
 * Duplicated from `@deepseek-ai/dsh-timeout` rather than imported: this package
 * configures a third-party transport and owns no harness deadline arithmetic.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * Validate one configured deadline. Unlike `@deepseek-ai/dsh-timeout`, where
 * zero is explicitly not a disable sentinel, `0` here is undici's own documented
 * "no deadline" value and is the only reason this validator differs.
 *
 * @param field - config field name, rendered into the thrown message.
 * @param value - the configured milliseconds.
 */
function assertTransportTimeout(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `http-timeout-policy: ${field} must be an integer between 0 (disabled) and ${MAX_TIMER_DELAY_MS}`,
    )
  }
}

/**
 * Install the configured dispatcher as undici's process-global dispatcher.
 *
 * Node's built-in `fetch` and the npm `undici` package share one dispatcher slot
 * (`globalThis[Symbol.for('undici.globalDispatcher.1')]`), so this reaches every
 * `fetch` caller in the process — including SDK-internal ones such as pi-ai's
 * OpenAI and Anthropic clients, which expose no per-request transport hook.
 * Dispose restores the dispatcher captured at mount and closes the Agent this
 * plugin created, so an HMR reload does not leak connection pools.
 *
 * @param ctx - Cordis context owning this plugin's lifetime.
 * @param config - validated transport deadlines.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertTransportTimeout('headersTimeoutMs', resolved.headersTimeoutMs)
  assertTransportTimeout('bodyTimeoutMs', resolved.bodyTimeoutMs)

  ctx.effect(() => {
    const previous = getGlobalDispatcher()
    const agent = new Agent({
      headersTimeout: resolved.headersTimeoutMs,
      bodyTimeout: resolved.bodyTimeoutMs,
    })
    setGlobalDispatcher(agent)
    return async () => {
      setGlobalDispatcher(previous)
      await agent.close()
    }
  }, 'http-timeout-policy: undici global dispatcher')
}
