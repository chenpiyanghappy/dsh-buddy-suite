import { createServer, request, type IncomingMessage, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buddyCheckinBalanceHandler,
  buddyCheckinStatusHandler,
  createBuddyCheckinStartup,
} from '../src/checkin-routes.ts'
import { today } from '../src/checkin.ts'
import type { ServerResponse } from 'node:http'

/**
 * Route specs against a real loopback server, so the Host/Origin gate and the
 * JSON body are exercised the way the browser half exercises them.
 */

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

/** Mount one handler on a loopback port and answer its origin. */
async function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): Promise<{ base: string, server: Server }> {
  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  CLEANUP.push(() => new Promise<void>(resolve => { server.close(() => resolve()) }))
  const port = (server.address() as AddressInfo).port
  return { base: `http://127.0.0.1:${port}`, server }
}

/**
 * Issue one request with full control over its headers.
 *
 * `fetch` cannot be used for the gate specs: undici overwrites a caller-set
 * `Host` with the URL's own host, so the DNS-rebinding case the gate exists
 * for could never be expressed. `http.request` sends the header verbatim.
 */
function send(
  base: string,
  options: { method?: string, path?: string, headers?: Record<string, string> } = {},
): Promise<{ status: number, headers: IncomingMessage['headers'], body: string }> {
  const url = new URL(base)
  return new Promise((resolve, reject) => {
    const req = request({
      host: url.hostname,
      port: url.port,
      method: options.method ?? 'GET',
      path: options.path ?? '/plugins/dsh-buddy-suite/checkin',
      headers: options.headers ?? {},
    }, res => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** Parse a JSON response body. */
function bodyOf(response: { body: string }): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>
}

/** A state file whose day is today, with one signed account. */
async function todayState(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'buddy-checkin-route-'))
  CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, '.buddy-checkin.json')
  await writeFile(path, JSON.stringify({
    day: today(),
    checkedAt: new Date().toISOString(),
    notice: 'WorkBuddy daily check-in complete: 1 account(s)',
    results: [{ uid: 'a', nickname: 'n', state: 'signed', at: new Date().toISOString(), credit: 100, balance: 3401 }],
  }))
  return path
}

/** Route options whose state file is the given path and whose startup is a no-op. */
function options(path: string): Parameters<typeof buddyCheckinStatusHandler>[0] {
  return { startup: async () => undefined, path }
}

describe('the status route', () => {
  it('answers a GET with the status document', async () => {
    const path = await todayState()
    const { base } = await serve(buddyCheckinStatusHandler(options(path)))
    const response = await send(base)
    expect(response.status).toBe(200)
    const body = bodyOf(response)
    expect(body['status']).toBe('ok')
    expect(body['day']).toBe(today())
    expect(Array.isArray(body['results'])).toBe(true)
    const results = body['results'] as Record<string, unknown>[]
    expect(results[0]!['uid']).toBe('a')
    // Timestamps cross the wire as epoch milliseconds.
    expect(typeof results[0]!['at']).toBe('number')
    expect(results[0]!['balance']).toBe(3401)
  })

  it('rejects a request whose Host is not loopback', async () => {
    const path = await todayState()
    const { base } = await serve(buddyCheckinStatusHandler(options(path)))
    // A DNS-rebinding page sends its own domain in Host; the gate drops it
    // before any state is read.
    const response = await send(base, { headers: { host: 'attacker.example' } })
    expect(response.status).toBe(403)
  })

  it('rejects a browser Origin that is not loopback', async () => {
    const path = await todayState()
    const { base } = await serve(buddyCheckinStatusHandler(options(path)))
    const response = await send(base, { headers: { origin: 'https://attacker.example' } })
    expect(response.status).toBe(403)
  })

  it('refuses methods it does not serve', async () => {
    const path = await todayState()
    const { base } = await serve(buddyCheckinStatusHandler(options(path)))
    const response = await send(base, { method: 'DELETE' })
    expect(response.status).toBe(405)
    expect(response.headers['allow']).toBe('GET, POST')
  })

  it('claims the one-shot notice on its first read', async () => {
    const path = await todayState()
    const { base } = await serve(buddyCheckinStatusHandler(options(path)))
    const first = await send(base)
    const firstBody = bodyOf(first)
    expect(firstBody['notice']).toBe('WorkBuddy daily check-in complete: 1 account(s)')
    const second = await send(base)
    const secondBody = bodyOf(second)
    expect(secondBody['notice']).toBeUndefined()
  })
})

describe('the balance route', () => {
  it('answers a POST only', async () => {
    const path = await todayState()
    const { base } = await serve(buddyCheckinBalanceHandler(options(path)))
    const response = await send(base, { method: 'GET', path: '/plugins/dsh-buddy-suite/checkin/balance' })
    expect(response.status).toBe(405)
    expect(response.headers['allow']).toBe('POST')
  })

  it('refreshes balances without repeating the check-in', async () => {
    const path = await todayState()
    const checkinCalls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('daily-checkin')) {
        checkinCalls.push(String(url))
        return { ok: true, status: 200, json: () => Promise.resolve({ code: 0, data: { credit: 1 } }) }
      }
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({ code: 0, data: { Response: { Data: { Accounts: [{ CycleCapacityRemain: 4242 }] } } } }),
      }
    }))
    const { base } = await serve(buddyCheckinBalanceHandler({
      ...options(path),
      accounts: [{ uid: 'a', accessToken: 'at', domain: 'www.codebuddy.cn' }],
    }))
    const response = await send(base, { method: 'POST', path: '/plugins/dsh-buddy-suite/checkin/balance' })
    expect(response.status).toBe(200)
    const body = bodyOf(response)
    const results = body['results'] as Record<string, unknown>[]
    // The balance was refreshed from the stubbed billing answer.
    expect(results[0]!['balance']).toBe(4242)
    expect(typeof results[0]!['balanceCheckedAt']).toBe('number')
    // And no check-in request was made: this route must never claim a day.
    expect(checkinCalls).toEqual([])
  })
})

describe('the startup attempt', () => {
  it('runs once and hands the same outcome to every later caller', async () => {
    let calls = 0
    const startup = createBuddyCheckinStartup({
      warn: () => { throw new Error('the startup attempt must not fail in this spec') },
    })
    // Stub the state path so the attempt does not touch the real home.
    vi.stubEnv('DSH_HOME', await mkdtemp(join(tmpdir(), 'buddy-checkin-startup-')))
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({ code: 0, data: { Response: { Data: { Accounts: [] } } } }),
      }
    }))
    const first = await startup()
    const second = await startup()
    // Both callers observe the same settled promise.
    expect(await first).toEqual(await second)
    // The attempt itself ran exactly once, however many callers joined it.
    expect(calls).toBeLessThanOrEqual(1)
  })
})
