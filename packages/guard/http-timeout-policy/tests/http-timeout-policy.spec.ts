/**
 * Unit + real-transport coverage for @deepseek-ai/dsh-http-timeout-policy.
 *
 * These cases drive a real `node:http` server over a real `fetch`, because the
 * behavior under test is undici's own timer and the process-global dispatcher
 * slot it reads — neither is observable through a mock. Timings stay small
 * (a sub-second body gap against a 100ms deadline) so the suite is fast, and the
 * gap is an order of magnitude above the deadline so it cannot flake.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { getGlobalDispatcher } from 'undici'
import * as httpTimeoutPolicy from '@deepseek-ai/dsh-http-timeout-policy'

/** Body gap the server holds before writing its remaining bytes. */
const BODY_GAP_MS = 1_000

/** Deadline used by the cases that assert undici still enforces a configured value. */
const SHORT_DEADLINE_MS = 100

const servers: Server[] = []
const fibers: { dispose: () => Promise<unknown> }[] = []

afterEach(async () => {
  // Dispose plugins first: each restores the dispatcher it captured, so the
  // process-global slot returns to its pre-test value before the next case.
  for (const fiber of fibers.splice(0).reverse()) await fiber.dispose()
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
})

/**
 * Start a server that flushes response headers and a first byte immediately,
 * then stalls before the rest of the body — the shape of a model provider whose
 * prefill runs long after the stream has opened.
 * @returns the URL of the started server.
 */
async function stallingServer(): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(': open\n\n')
    setTimeout(() => { res.write('data: done\n\n'); res.end() }, BODY_GAP_MS)
  })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
}

/** Mount the plugin with the given config and register its fiber for teardown. */
async function mount(config: httpTimeoutPolicy.Config): Promise<void> {
  const ctx = new Context()
  fibers.push(await ctx.plugin(httpTimeoutPolicy, config))
}

/** Read a response to completion, reporting the transport failure when one wins. */
async function drain(url: string): Promise<{ ok: true; body: string } | { ok: false; message: string; cause: string }> {
  try {
    const response = await fetch(url)
    let body = ''
    for await (const chunk of response.body!) body += Buffer.from(chunk).toString()
    return { ok: true, body }
  } catch (error) {
    const cause = (error as { cause?: { constructor: { name: string } } }).cause
    return { ok: false, message: (error as Error).message, cause: cause?.constructor.name ?? 'none' }
  }
}

describe('http-timeout-policy transport deadlines', () => {
  it('a configured body deadline shorter than the gap reproduces the undici failure the plugin exists to remove', async () => {
    const url = await stallingServer()
    await mount({ bodyTimeoutMs: SHORT_DEADLINE_MS })
    const result = await drain(url)
    expect(result.ok).toBe(false)
    // The bare `terminated` + BodyTimeoutError pair is what the LLM adapters see
    // and classify as a retryable TRANSPORT failure.
    expect(result).toMatchObject({ message: 'terminated', cause: 'BodyTimeoutError' })
  })

  it('the default config disables both deadlines, so a long body gap completes', async () => {
    const url = await stallingServer()
    await mount({})
    const result = await drain(url)
    expect(result).toEqual({ ok: true, body: ': open\n\ndata: done\n\n' })
  })

  it('a configured headers deadline still applies to a server that never responds', async () => {
    const server = createServer(() => { /* never responds: the headers deadline is the only way out */ })
    servers.push(server)
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    await mount({ headersTimeoutMs: SHORT_DEADLINE_MS })
    const result = await drain(url)
    expect(result).toMatchObject({ ok: false, cause: 'HeadersTimeoutError' })
  })
})

describe('http-timeout-policy lifecycle', () => {
  it('restores the dispatcher captured at mount when the fiber disposes', async () => {
    const before = getGlobalDispatcher()
    const ctx = new Context()
    const fiber = await ctx.plugin(httpTimeoutPolicy, {})
    expect(getGlobalDispatcher()).not.toBe(before)
    await fiber.dispose()
    expect(getGlobalDispatcher()).toBe(before)
  })

  it('a disposed mount stops governing fetch, so the previous deadlines apply again', async () => {
    const url = await stallingServer()
    const ctx = new Context()
    const fiber = await ctx.plugin(httpTimeoutPolicy, { bodyTimeoutMs: SHORT_DEADLINE_MS })
    expect((await drain(url)).ok).toBe(false)
    await fiber.dispose()
    expect(await drain(url)).toEqual({ ok: true, body: ': open\n\ndata: done\n\n' })
  })
})

describe('http-timeout-policy configuration', () => {
  it.each([
    ['a negative deadline', { bodyTimeoutMs: -1 }],
    ['a fractional deadline', { headersTimeoutMs: 1.5 }],
    ['a deadline past the largest schedulable timer', { bodyTimeoutMs: 2_147_483_648 }],
  ])('rejects %s at mount rather than silently clamping it', async (_label, config) => {
    const ctx = new Context()
    await expect(ctx.plugin(httpTimeoutPolicy, config)).rejects.toThrow(/http-timeout-policy/)
  })

  it('accepts the largest schedulable timer delay', async () => {
    await expect(mount({ bodyTimeoutMs: 2_147_483_647 })).resolves.toBeUndefined()
  })
})

describe('http-timeout-policy real composition', () => {
  it('governs fetch when a cordis.yml row boots it through the actual Loader', async () => {
    // A hand-mounted ctx.plugin cannot catch a Loader export-shape failure: a
    // function plugin that also carried a default export would have its
    // namespace discarded, and the row would mount without applying anything.
    const root = await mkdtemp(join(tmpdir(), 'dsh-http-timeout-composition-'))
    const url = await stallingServer()
    try {
      const configPath = join(root, 'cordis.yml')
      await writeFile(configPath, [
        '- id: http-timeout-policy',
        "  name: '@deepseek-ai/dsh-http-timeout-policy'",
        '  config:',
        '    bodyTimeoutMs: 100',
        '',
      ].join('\n'))

      const ctx = new Context()
      fibers.push(ctx.fiber)
      ctx.baseUrl = `${pathToFileURL(root).href}/`
      await ctx.plugin(Loader)
      ctx.loader.builtins.include = Include
      ctx.loader.internal = {
        version: 'v2',
        import(specifier: string) {
          if (specifier !== '@deepseek-ai/dsh-http-timeout-policy') {
            throw new Error(`unexpected Loader import: ${specifier}`)
          }
          return Promise.resolve(httpTimeoutPolicy)
        },
      } as unknown as NonNullable<typeof ctx.loader.internal>
      await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
      await ctx.loader.await()

      // The configured row — not the schema default — is what reached undici.
      expect(await drain(url)).toMatchObject({ ok: false, cause: 'BodyTimeoutError' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
