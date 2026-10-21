import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { check, retryFailed, run, today, type BuddyCheckinCredential } from '../src/checkin.ts'

/**
 * T1 check-in degradation: a rate limit or an upstream shape change ends the
 * day's attempts for that account instead of retrying forever. Offline: every
 * `fetch` is stubbed.
 */

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
  vi.unstubAllGlobals()
})

const CREDENTIAL: BuddyCheckinCredential = {
  uid: 'uid-1',
  nickname: 'tester',
  accessToken: 'at',
  domain: 'www.codebuddy.cn',
}

/** A JSON response for the stubbed fetch. */
function json(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response
}

/** A response whose body is not JSON at all. */
function html(status = 200): Response {
  return {
    ok: true,
    status,
    json: () => Promise.reject(new SyntaxError('Unexpected token <')),
    text: () => Promise.resolve('<html>gateway</html>'),
  } as unknown as Response
}

describe('check records the stop code', () => {
  it('stops on HTTP 429', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 1, msg: 'too many requests' }, false, 429)))
    const result = await check(CREDENTIAL)
    expect(result.state).toBe('failed')
    expect(result.stopCode).toBe('RATE_LIMITED')
    expect(result.error).toContain('too many requests')
  })

  it('stops when the answer is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => html()))
    const result = await check(CREDENTIAL)
    expect(result.state).toBe('failed')
    expect(result.stopCode).toBe('UPSTREAM_PROTOCOL_CHANGED')
  })

  it('stops when the check-in endpoint has moved', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 1, msg: 'not found' }, false, 404)))
    const result = await check(CREDENTIAL)
    expect(result.state).toBe('failed')
    expect(result.stopCode).toBe('UPSTREAM_PROTOCOL_CHANGED')
  })

  it('leaves an ordinary credit failure retryable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 1, msg: 'insufficient credit' }, false, 402)))
    const result = await check(CREDENTIAL)
    expect(result.state).toBe('failed')
    expect(result.stopCode).toBeUndefined()
    expect(result.error).toContain('insufficient credit')
  })

  it('leaves an expired session retryable (signing in again fixes it)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 401, msg: 'session expired' }, false, 401)))
    const result = await check(CREDENTIAL)
    expect(result.state).toBe('failed')
    expect(result.stopCode).toBeUndefined()
  })

  it('still claims a normal check-in', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/daily-checkin')
      ? json({ code: 0, data: { credit: 100 } })
      : json({ code: 0, data: { Response: { Data: { Accounts: [{ CycleCapacityRemain: 7 }] } } } })))
    const result = await check(CREDENTIAL)
    expect(result.state).toBe('signed')
    expect(result.credit).toBe(100)
    expect(result.stopCode).toBeUndefined()
  })
})

describe('retryFailed leaves stopped rows alone', () => {
  it('makes no request for a row that stopped today', async () => {
    const home = await mkdtemp(join(tmpdir(), 'buddy-checkin-stop-'))
    CLEANUP.push(() => rm(home, { recursive: true, force: true }))
    const path = join(home, '.buddy-checkin.json')
    const at = new Date().toISOString()
    await writeFile(path, JSON.stringify({
      day: today(),
      checkedAt: at,
      results: [
        { uid: 'uid-1', state: 'failed', at, error: 'too many requests', stopCode: 'RATE_LIMITED' },
      ],
    }))
    const checkIns: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('daily-checkin')) checkIns.push(String(url))
      return json({ code: 1, msg: 'should not be called' }, false, 500)
    }))

    const saved = await retryFailed(path)

    // The stop code survives, and no check-in request was attempted for it.
    const row = saved.results.find(entry => entry.uid === 'uid-1')
    expect(row?.stopCode).toBe('RATE_LIMITED')
    expect(row?.state).toBe('failed')
    expect(checkIns).toEqual([])
  })
})

/**
 * A restart must not re-litigate a stop code either.
 *
 * `run()` discovers accounts from the platform directories, so this spec points
 * `LOCALAPPDATA`/`APPDATA` at a temp tree carrying one CN backup, and is
 * Windows-only because that probe layout is what the discovery reads.
 */
describe.skipIf(process.platform !== 'win32')('run carries a stopped row over a restart', () => {
  it('does not send another check-in for an account that already stopped today', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-checkin-run-stop-'))
    CLEANUP.push(() => rm(root, { recursive: true, force: true }))
    const authDir = join(root, 'CodeBuddyExtension', 'Data', 'Public', 'auth')
    await mkdir(authDir, { recursive: true })
    await writeFile(join(authDir, 'workbuddy-desktop.info'), JSON.stringify({
      auth: { accessToken: 'at', domain: 'www.codebuddy.cn', expiresAt: 4_102_444_800 },
      account: { uid: 'uid-1', nickname: 'tester', enterpriseId: '' },
    }))
    vi.stubEnv('LOCALAPPDATA', root)
    vi.stubEnv('APPDATA', root)
    vi.stubEnv('DSH_HOME', join(root, 'dsh-home'))
    const path = join(root, 'dsh-home', '.buddy-checkin.json')
    const at = new Date().toISOString()
    await mkdir(join(root, 'dsh-home'), { recursive: true })
    await writeFile(path, JSON.stringify({
      day: today(),
      checkedAt: at,
      results: [{ uid: 'uid-1', state: 'failed', at, error: 'too many requests', stopCode: 'RATE_LIMITED' }],
    }))
    const checkIns: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('daily-checkin')) checkIns.push(String(url))
      return json({ code: 1, msg: 'should not be called' }, false, 500)
    }))

    const saved = await run(path, { notice: false })

    const row = saved.results.find(entry => entry.uid === 'uid-1')
    expect(row?.stopCode).toBe('RATE_LIMITED')
    expect(checkIns).toEqual([])
  })
})
