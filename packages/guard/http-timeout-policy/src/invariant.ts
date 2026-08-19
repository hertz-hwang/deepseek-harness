/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-http-timeout-policy`.
 * @module @deepseek-ai/dsh-http-timeout-policy/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-http-timeout-policy'

/** Cordis companion plugin name. */
export const name = 'http-timeout-policy-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this plugin owns one process-global transport setting
 * and no package-local event history or mutable data relation. Its single
 * relationship — the global dispatcher matching the mounted config, and
 * reverting on dispose — belongs to a third-party module's process state rather
 * than an authoritative harness stream, and is covered by the package tests.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
