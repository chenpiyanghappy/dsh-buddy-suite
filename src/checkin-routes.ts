/**
 * Same-origin HTTP routes for the check-in half: the status document the
 * details panel renders, and the write endpoints it drives.
 *
 * The routes answer loopback browser requests only — the Host/Origin pair
 * drops DNS-rebinding pages — and never carry token material: every field that
 * crosses to the browser is either a display name the user already sees in
 * the app, a calendar day, a credit figure, or a prose diagnosis.
 *
 * Two routes, deliberately:
 *
 * - {@link BUDDY_CHECKIN_PATH} answers `GET` with the status document and
 *   `POST` to retry today's failed accounts. Both are idempotent: `GET`
 *   re-reads persisted state (and claims the one-shot notice), and `POST`
 *   re-requests only rows that failed today.
 * - {@link BUDDY_CHECKIN_BALANCE_PATH} answers `POST` only, and does two
 *   things in that order: sign today if the process has been running across
 *   midnight (the lazy day rollover), then refresh every balance. Opening the
 *   panel is the trigger, so a plain status read never mutates.
 *
 * @module dsh-buddy-suite/checkin-routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  claimNotice,
  discover,
  documentOf,
  ensureToday,
  load,
  refreshBalances,
  retryFailed,
  run,
} from './checkin.ts'
import type { BuddyCheckinCredential, BuddyCheckinDiscoveryOptions } from './checkin.ts'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import { BUDDY_CHECKIN_BALANCE_PATH, BUDDY_CHECKIN_PATH } from './status-paths.ts'
import type { BuddyCheckinDocument } from './status-paths.ts'

export { BUDDY_CHECKIN_PATH, BUDDY_CHECKIN_BALANCE_PATH } from './status-paths.ts'

/** Route dependencies. */
export interface BuddyCheckinRouteOptions {
  /**
   * How the decryption key is resolved. Injected so tests never spawn the
   * app's Electron; omitted in production, where the default source runs.
   */
  discovery?: BuddyCheckinDiscoveryOptions
  /**
   * The state file the routes read and write. Defaults to the real
   * `$DSH_HOME` location; tests point it at a temp file so a spec never
   * touches the machine's own check-in state.
   */
  path?: string
  /**
   * The credentials the balance refresh reads, when the caller already holds
   * them. Defaults to a fresh discovery scan, which is what production does —
   * it is the only way a newly signed-in account appears in the panel.
   */
  accounts?: readonly BuddyCheckinCredential[]
  /**
   * The startup attempt, shared by every route so the first panel open never
   * races the initial run and never starts a second one.
   */
  startup: () => Promise<unknown>
}

/** Write a JSON body with an explicit status and optional extra headers. */
function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers })
  res.end(payload)
}

/**
 * The request must be addressed to the loopback interface, and a
 * browser-attached Origin must be loopback too. Non-browser clients send no
 * Origin and pass on Host alone.
 */
function loopbackRequest(req: IncomingMessage): boolean {
  return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin)
}

/**
 * The status document, with the one-shot notice claimed by this read.
 *
 * `claimNotice` strips the notice from the state file as it hands it over, so
 * a remount or a second browser window no longer re-toasts the startup
 * summary. The claim is best-effort by construction: a failed write only
 * costs a repeat toast, never the day's results.
 */
export async function buddyCheckinStatus(
  opts: BuddyCheckinRouteOptions,
): Promise<BuddyCheckinDocument> {
  await opts.startup()
  const claimed = await claimNotice(opts.path)
  return documentOf(claimed)
}

/**
 * Retry today's failed accounts.
 *
 * Accounts that already succeeded are never re-requested, so a retry is safe
 * to press repeatedly and cannot claim a second day's credit.
 */
export async function buddyCheckinRetry(
  opts: BuddyCheckinRouteOptions,
): Promise<BuddyCheckinDocument> {
  await opts.startup()
  const saved = await retryFailed(opts.path)
  return documentOf(saved)
}

/**
 * Sign today if the process has been running across midnight, then refresh
 * every account's balance.
 *
 * The rollover runs with `notice: false` on purpose: the panel-open rollover
 * shows its outcome in the panel itself, so a notice would toast some later
 * page load out of nowhere.
 */
export async function buddyCheckinBalance(
  opts: BuddyCheckinRouteOptions,
): Promise<BuddyCheckinDocument> {
  await opts.startup()
  await ensureToday(opts.path, { notice: false })
  const accounts = await discoverAccounts(opts)
  const saved = await refreshBalances(opts.path, accounts)
  return documentOf(saved ?? await load(opts.path))
}

/** Discover credentials for the balance refresh; failures degrade to "no accounts". */
async function discoverAccounts(opts: BuddyCheckinRouteOptions): Promise<readonly BuddyCheckinCredential[] | undefined> {
  // An injected list wins: it is what tests use, and it is also how a caller
  // that already holds the credentials avoids a second directory scan.
  if (opts.accounts !== undefined) return opts.accounts
  try {
    const found = await discover(undefined, opts.discovery ?? {})
    return found.credentials
  } catch {
    // A discovery failure here must not fail the balance refresh: the
    // persisted rows still render, each with a balance error.
    return undefined
  }
}

/** The status route's request handler, extracted so tests can mount it on a bare server. */
export function buddyCheckinStatusHandler(
  opts: BuddyCheckinRouteOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    try {
      if (req.method === 'GET') {
        json(res, 200, await buddyCheckinStatus(opts))
        return
      }
      if (req.method === 'POST') {
        json(res, 200, await buddyCheckinRetry(opts))
        return
      }
      json(res, 405, { error: 'method-not-allowed' }, { Allow: 'GET, POST' })
    } catch (error: unknown) {
      json(res, 500, { error: safeMessage(error) })
    }
  }
}

/** The balance route's request handler. */
export function buddyCheckinBalanceHandler(
  opts: BuddyCheckinRouteOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    try {
      if (req.method === 'POST') {
        json(res, 200, await buddyCheckinBalance(opts))
        return
      }
      json(res, 405, { error: 'method-not-allowed' }, { Allow: 'POST' })
    } catch (error: unknown) {
      json(res, 500, { error: safeMessage(error) })
    }
  }
}

/** Redact token-like content before it crosses to the browser. */
function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 500)
}

/**
 * Mount both check-in routes on an optional webServer context.
 *
 * The webServer service is optional: a headless profile serves no browser, so
 * the routes simply never mount there while the startup attempt still runs.
 */
export function registerBuddyCheckinRoutes(ctx: Context, opts: BuddyCheckinRouteOptions): void {
  ctx.inject(['webServer'], webCtx => {
    webCtx.effect(() => {
      const disposeStatus = webCtx.webServer.register({
        kind: 'exact',
        path: BUDDY_CHECKIN_PATH,
        handler: buddyCheckinStatusHandler(opts),
      })
      const disposeBalance = webCtx.webServer.register({
        kind: 'exact',
        path: BUDDY_CHECKIN_BALANCE_PATH,
        handler: buddyCheckinBalanceHandler(opts),
      })
      return () => {
        disposeStatus()
        disposeBalance()
      }
    }, 'dsh-buddy-suite: check-in routes')
  })
}

/** The startup attempt the routes await; exported for tests. */
export function createBuddyCheckinStartup(
  logger?: { warn(...args: unknown[]): void },
): () => Promise<unknown> {
  let settled: Promise<unknown> | undefined
  return () => {
    settled ??= run().catch((error: unknown) => {
      logger?.warn('dsh-buddy-suite: WorkBuddy check-in failed', error)
      return undefined
    })
    // The settled promise is kept, not cleared: every later caller must
    // observe the same outcome as the first, so a panel opened seconds after
    // startup cannot start a second run — and a failed run is not retried by
    // the panel (retrying is what its own button is for).
    return settled
  }
}
