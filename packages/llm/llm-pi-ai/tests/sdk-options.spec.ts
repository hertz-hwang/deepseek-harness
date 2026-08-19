import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

const streamSimple = vi.hoisted(() => vi.fn())

// A hand-declared route is built by `createProvider` over the protocol table in
// `src/provider.ts`, so the table's lazy api module is the SDK boundary this
// test can observe. A catalog route dispatches through pi-ai's own provider and
// would not see this mock.
vi.mock('@earendil-works/pi-ai/api/openai-completions.lazy', () => ({
  openAICompletionsApi: () => ({ stream: streamSimple, streamSimple }),
}))

import { PiAiAdapter } from '../src/adapter.ts'
import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  resolveProfiles,
  type PiAiProviderProfile,
} from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'

afterEach(() => { streamSimple.mockReset() })

/** A hand-declared OpenAI-compatible route with one fully described model. */
function gatewayAdapter(profile: Partial<PiAiProviderProfile> = {}): PiAiAdapter {
  return new PiAiAdapter({
    profiles: () => resolveProfiles({
      'local-gateway': {
        api: 'openai-completions',
        baseURL: 'http://127.0.0.1:9/v1',
        models: [{ id: 'local-model', contextWindow: 8192, maxTokens: 1024 }],
        ...profile,
      },
    }),
    resolveApiKey: () => Promise.resolve('test-key'),
    auth: memoryAuth(),
  })
}

async function drain(adapter: PiAiAdapter): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({
    provider: 'local-gateway',
    model: 'local-model',
    messages: [],
  })) chunks.push(chunk)
  return chunks
}

describe('pi-ai SDK retry boundary', () => {
  it('pins one SDK attempt even when the installed provider currently defaults to zero retries', async () => {
    streamSimple.mockImplementation(() => { throw new Error('mock SDK boundary') })

    const chunks = await drain(gatewayAdapter())

    expect(streamSimple).toHaveBeenCalledOnce()
    expect(streamSimple.mock.calls[0]?.[2]).toMatchObject({ maxRetries: 0, apiKey: 'test-key' })
    // pi-ai reports a setup failure as a terminal in-stream error rather than
    // throwing, which the converter turns into the harness error finish.
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'mock SDK boundary' } },
    })
  })

  it('dispatches a hand-declared route to the endpoint and model its configuration describes', async () => {
    streamSimple.mockImplementation(() => { throw new Error('mock SDK boundary') })

    await drain(gatewayAdapter())

    expect(streamSimple.mock.calls[0]?.[0]).toMatchObject({
      id: 'local-model',
      provider: 'local-gateway',
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:9/v1',
      contextWindow: 8192,
      maxTokens: 1024,
    })
  })
})

describe('pi-ai SDK whole-request deadline', () => {
  it('always forwards timeoutMs, so the SDK never falls back to its own default', async () => {
    streamSimple.mockImplementation(() => { throw new Error('mock SDK boundary') })

    await drain(gatewayAdapter())

    // An omitted option would let the SDK apply its own ten-minute abort, which
    // preempts the route's idle watchdog on a slow-prefill provider.
    expect(streamSimple.mock.calls[0]?.[2]).toMatchObject({ timeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS })
  })

  it('tracks streamIdleTimeoutMs when the profile configures only the idle interval', async () => {
    streamSimple.mockImplementation(() => { throw new Error('mock SDK boundary') })

    await drain(gatewayAdapter({ streamIdleTimeoutMs: 86_400_000 }))

    expect(streamSimple.mock.calls[0]?.[2]).toMatchObject({ timeoutMs: 86_400_000 })
  })

  it('keeps an explicitly configured timeoutMs independent of the idle interval', async () => {
    streamSimple.mockImplementation(() => { throw new Error('mock SDK boundary') })

    await drain(gatewayAdapter({ streamIdleTimeoutMs: 86_400_000, timeoutMs: 5_000 }))

    expect(streamSimple.mock.calls[0]?.[2]).toMatchObject({ timeoutMs: 5_000 })
  })

  it.each([0, Number.NaN, 2_147_483_648])('refuses an unusable configured timeoutMs (%s)', (timeoutMs) => {
    expect(() => resolveProfiles({ 'local-gateway': { timeoutMs } })).toThrow(/timeoutMs must be a positive finite/)
  })
})
