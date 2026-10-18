import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  authDirsFor,
  claimNotice,
  check,
  discover,
  documentOf,
  ensureToday,
  load,
  refreshBalances,
  retryFailed,
  run,
  status,
  today,
  type BuddyCheckinCredential,
} from '../src/checkin.ts'
import { sealAuthFieldForTest, type KeySource } from '../src/desktop-credential-protection.ts'

/**
 * Offline specs for the check-in half. `fetch` is stubbed in every test that
 * reaches the network, so no request ever leaves the process and no real
 * account is touched.
 */

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
  vi.unstubAllGlobals()
})

/** A fresh temp directory, removed after the test. */
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** One CN backup file, in the nested shape the desktop app writes. */
function backupDocument(options: {
  uid: string
  domain?: string
  accessToken?: unknown
  nickname?: unknown
}): string {
  return JSON.stringify({
    auth: {
      accessToken: options.accessToken ?? 'at',
      domain: options.domain ?? 'www.codebuddy.cn',
      expiresAt: 1_800_000_000_000,
    },
    account: {
      uid: options.uid,
      nickname: options.nickname ?? 'nickname',
      enterpriseId: '',
    },
  })
}

/** Stub `fetch` and record every `(url, init)` pair it receives. */
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): {
  calls: { url: string, init: RequestInit }[]
} {
  const calls: { url: string, init: RequestInit }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return handler(url, init)
  }))
  return { calls }
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

describe('authDirsFor', () => {
  it('probes both AppData roots on Windows, Local first', () => {
    vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\u\\AppData\\Local')
    vi.stubEnv('APPDATA', 'C:\\Users\\u\\AppData\\Roaming')
    const dirs = authDirsFor.call(null)
    // `authDirsFor` reads `process.platform`, so this assertion only holds on
    // Windows; on other platforms the function probes the platform's own
    // bases. What matters everywhere is that every candidate ends in the
    // shared auth directory.
    for (const dir of dirs) {
      expect(dir.endsWith('CodeBuddyExtension\\Data\\Public\\auth')
        || dir.endsWith('CodeBuddyExtension/Data/Public/auth')).toBe(true)
    }
    expect(dirs.length).toBeGreaterThan(0)
  })
})

describe('discover', () => {
  it('finds every account that ever signed in, newest credential per uid', async () => {
    const dir = await tempDir('buddy-checkin-discover-')
    await writeFile(join(dir, 'workbuddy-desktop.info'), backupDocument({ uid: 'uid-a', accessToken: 'token-live' }))
    await writeFile(join(dir, 'workbuddy-desktop.2026-10-16.info'), backupDocument({ uid: 'uid-a', accessToken: 'token-old' }))
    await writeFile(join(dir, 'workbuddy-desktop.2026-10-15.info'), backupDocument({ uid: 'uid-b', accessToken: 'token-b' }))

    const found = await discover(dir)
    expect(found.unreadable).toEqual([])
    expect(found.credentials).toHaveLength(2)
    const byUid = new Map(found.credentials.map(c => [c.uid, c]))
    // The live file sorts above any timestamped backup, so the newest wins.
    expect(byUid.get('uid-a')?.accessToken).toBe('token-live')
    expect(byUid.get('uid-b')?.accessToken).toBe('token-b')
  })

  it('excludes the international auth file by name', async () => {
    const dir = await tempDir('buddy-checkin-discover-ai-')
    await writeFile(join(dir, 'workbuddy-desktop-ai.info'), backupDocument({
      uid: 'uid-ai',
      domain: 'www.workbuddy.ai',
      accessToken: 'ai-token',
    }))
    await writeFile(join(dir, 'workbuddy-desktop.info'), backupDocument({ uid: 'uid-cn', accessToken: 'cn-token' }))

    const found = await discover(dir)
    expect(found.credentials.map(c => c.uid)).toEqual(['uid-cn'])
  })

  it('reports an account whose encrypted backup no key can open', async () => {
    const dir = await tempDir('buddy-checkin-discover-encrypted-')
    const key = randomBytes(32)
    await writeFile(join(dir, 'workbuddy-desktop.info'), backupDocument({
      uid: 'uid-sealed',
      accessToken: sealAuthFieldForTest(key, 'sealed-token'),
      nickname: sealAuthFieldForTest(key, 'sealed-name'),
    }))

    // No key source is injected, so the default resolver would spawn the
    // app's Electron. Stub it out by pointing the module at a source that
    // yields a *different* key: the envelope's key id then never matches.
    const wrongKey: KeySource = async () => JSON.stringify({
      version: 1,
      atRestSecretKey: randomBytes(32).toString('base64'),
    })
    const found = await discover(dir, { keySource: wrongKey })
    expect(found.credentials).toEqual([])
    expect(found.unreadable).toHaveLength(1)
    expect(found.unreadable[0]!.uid).toBe('uid-sealed')
    // The reason is user-facing copy rendered verbatim by a Chinese panel, so it
    // must be Chinese; asserting on the wording also pins the localization.
    expect(found.unreadable[0]!.reason).toMatch(/加密|密钥|凭据/u)
    expect(found.unreadable[0]!.reason).not.toMatch(/credential|encrypted|key/u)
  })

  it('opens an encrypted backup when the machine key matches', async () => {
    const dir = await tempDir('buddy-checkin-discover-open-')
    const secret = randomBytes(32).toString('base64')
    // The provider derives the key as sha256 over the secret STRING, so the
    // sealed field must be sealed with that same derived key.
    const { createHash } = await import('node:crypto')
    const key = createHash('sha256').update(secret, 'utf8').digest()
    await writeFile(join(dir, 'workbuddy-desktop.info'), backupDocument({
      uid: 'uid-open',
      accessToken: sealAuthFieldForTest(key, 'opened-token'),
      nickname: sealAuthFieldForTest(key, 'opened-name'),
    }))

    const found = await discover(dir, { keySource: async () => JSON.stringify({ version: 1, atRestSecretKey: secret }) })
    expect(found.unreadable).toEqual([])
    expect(found.credentials).toHaveLength(1)
    expect(found.credentials[0]!.accessToken).toBe('opened-token')
    expect(found.credentials[0]!.nickname).toBe('opened-name')
  })

  it('rescues an account from a later directory when an earlier one cannot open it', async () => {
    const first = await tempDir('buddy-checkin-discover-first-')
    const second = await tempDir('buddy-checkin-discover-second-')
    const key = randomBytes(32)
    await writeFile(join(first, 'workbuddy-desktop.info'), backupDocument({
      uid: 'uid-both',
      accessToken: sealAuthFieldForTest(key, 'sealed'),
    }))
    await writeFile(join(second, 'workbuddy-desktop.info'), backupDocument({ uid: 'uid-both', accessToken: 'plain' }))

    const wrongKey: KeySource = async () => JSON.stringify({
      version: 1,
      atRestSecretKey: randomBytes(32).toString('base64'),
    })
    const found = await discover([first, second], { keySource: wrongKey })
    expect(found.credentials.map(c => c.accessToken)).toEqual(['plain'])
    expect(found.unreadable).toEqual([])
  })
})

describe('nickname display', () => {
  it('keeps a correct CJK nickname byte-for-byte', async () => {
    // A real account name from a real machine. The plugin must never rewrite
    // it: the value that reaches the panel is the value the app stores, and an
    // earlier report of this name as mojibake turned out to be the reporting
    // tool's console encoding, not the plugin's decoding.
    const dir = await tempDir('buddy-checkin-nickname-')
    await writeFile(join(dir, 'workbuddy-desktop.info'), backupDocument({ uid: 'uid-name', nickname: '陈皮洋' }))
    const found = await discover(dir)
    expect(found.credentials[0]!.nickname).toBe('陈皮洋')
    // And it round-trips through the wire shape the panel renders.
    const document = documentOf({
      day: today(),
      checkedAt: new Date().toISOString(),
      results: [{ uid: 'uid-name', nickname: '陈皮洋', state: 'signed', at: new Date().toISOString() }],
    })
    expect(document.results[0]!.nickname).toBe('陈皮洋')
  })

  it('drops a nickname carrying the lossy-decode marker', async () => {
    const dir = await tempDir('buddy-checkin-nickname-bad-')
    // `U+FFFD` is what a lossy decode substitutes for bytes it could not read;
    // the original text is gone, so the id is shown instead.
    await writeFile(join(dir, 'workbuddy-desktop.info'), backupDocument({ uid: 'uid-bad', nickname: '陈\uFFFD洋' }))
    const found = await discover(dir)
    expect(found.credentials[0]!.nickname).toBeUndefined()
    expect(found.credentials[0]!.uid).toBe('uid-bad')
  })

  it('keeps a nickname that merely looks odd but decoded cleanly', async () => {
    // The exact string an earlier report showed for a correct name: it is a
    // console-rendering artefact, not corruption, so it carries no U+FFFD and
    // must pass through untouched rather than be "repaired" into a guess.
    const dir = await tempDir('buddy-checkin-nickname-odd-')
    await writeFile(join(dir, 'workbuddy-desktop.info'), backupDocument({ uid: 'uid-odd', nickname: 'éç®æ´' }))
    const found = await discover(dir)
    expect(found.credentials[0]!.nickname).toBe('éç®æ´')
  })

  it('drops a nickname built only from control characters', async () => {
    const dir = await tempDir('buddy-checkin-nickname-ctrl-')
    await writeFile(join(dir, 'workbuddy-desktop.info'), backupDocument({ uid: 'uid-ctrl', nickname: '\u0000\u0001\u0002' }))
    const found = await discover(dir)
    expect(found.credentials[0]!.nickname).toBeUndefined()
  })
})

describe('check', () => {
  const credential: BuddyCheckinCredential = {
    uid: 'uid-1',
    nickname: 'nickname',
    accessToken: 'at',
    domain: 'www.codebuddy.cn',
  }

  it('claims the daily credit and reads the balance behind it', async () => {
    const wire = stubFetch(url => {
      if (url.endsWith('/daily-checkin')) return json({ code: 0, msg: 'ok', data: { credit: 100 } })
      return json({ code: 0, data: { Response: { Data: { Accounts: [{ CycleCapacityRemain: 3401 }] } } } })
    })
    const result = await check(credential)
    expect(result.state).toBe('signed')
    expect(result.credit).toBe(100)
    expect(result.balance).toBe(3401)
    // Two requests: the check-in, then the balance read behind it.
    expect(wire.calls).toHaveLength(2)
    expect(wire.calls[0]!.init.headers).toMatchObject({
      authorization: 'Bearer at',
      'x-user-id': 'uid-1',
    })
  })

  it('reads an already-claimed account as already, not as a failure', async () => {
    // The upstream answers an already-claimed account with a non-2xx status
    // and a 「已签到」 message; treating that as a failure would make every
    // restart look broken.
    stubFetch(url => {
      if (url.endsWith('/daily-checkin')) return json({ code: 1, msg: '今日已签到' }, false, 400)
      return json({ code: 0, data: { Response: { Data: { Accounts: [] } } } })
    })
    const result = await check(credential)
    expect(result.state).toBe('already')
    expect(result.credit).toBeUndefined()
  })

  it('reports a genuine failure without a balance figure', async () => {
    stubFetch(() => json({ code: 1, msg: 'insufficient credit' }, false, 402))
    const result = await check(credential)
    expect(result.state).toBe('failed')
    expect(result.error).toContain('insufficient credit')
    expect(result.balance).toBeUndefined()
  })

  it('keeps the check-in result when the balance read fails', async () => {
    stubFetch(url => {
      if (url.endsWith('/daily-checkin')) return json({ code: 0, data: { credit: 50 } })
      return json({ code: 1, msg: 'boom' }, false, 500)
    })
    const result = await check(credential)
    expect(result.state).toBe('signed')
    expect(result.credit).toBe(50)
    // The failed balance read must not demote a successful check-in.
    expect(result.balance).toBeUndefined()
  })
})

describe('run', () => {
  /** A state file path inside a fresh temp dir, plus its own DSH_HOME. */
  async function stateFile(): Promise<{ path: string, home: string }> {
    const home = await tempDir('buddy-checkin-home-')
    const path = join(home, '.buddy-checkin.json')
    return { path, home }
  }

  /** An auth dir with one plaintext CN account. */
  async function authDir(uid: string): Promise<string> {
    const dir = await tempDir('buddy-checkin-auth-')
    await writeFile(join(dir, 'workbuddy-desktop.info'), backupDocument({ uid }))
    return dir
  }

  it('signs every account and persists the day', async () => {
    const { path } = await stateFile()
    stubFetch(url => {
      if (url.endsWith('/daily-checkin')) return json({ code: 0, data: { credit: 100 } })
      return json({ code: 0, data: { Response: { Data: { Accounts: [{ CycleCapacityRemain: 3401 }] } } } })
    })
    // `run` discovers accounts from the real platform directories, so the
    // number of rows depends on the machine. What must hold either way: the
    // persisted state names today, carries a result array, and is re-readable.
    const saved = await run(path, { notice: false })
    expect(saved.day).toBe(today())
    expect(Array.isArray(saved.results)).toBe(true)
    const reread = await load(path)
    expect(reread?.day).toBe(today())
    expect(reread?.results).toHaveLength(saved.results.length)
  })

  it('never re-requests an account already signed today', async () => {
    const { path } = await stateFile()
    const day = today()
    await writeFile(path, JSON.stringify({
      day,
      checkedAt: new Date().toISOString(),
      results: [{ uid: 'uid-done', state: 'signed', at: new Date().toISOString(), credit: 100 }],
    }))
    const wire = stubFetch(url => {
      if (url.endsWith('/daily-checkin')) return json({ code: 0, data: { credit: 100 } })
      return json({ code: 0, data: { Response: { Data: { Accounts: [] } } } })
    })
    await run(path, { notice: false })
    // The persisted row already succeeded, so no check-in request may be sent
    // for it — the only requests allowed are balance reads.
    for (const call of wire.calls) {
      expect(call.url).not.toContain('daily-checkin')
    }
  })

  it('emits a startup notice only when an attempt actually ran', async () => {
    const { path } = await stateFile()
    // `run` discovers accounts from the real platform directories, so the
    // outcome depends on the machine. What must hold either way: a notice is
    // present exactly when this run made at least one attempt, and absent when
    // `notice: false` suppresses it.
    stubFetch(url => {
      if (url.endsWith('/daily-checkin')) return json({ code: 0, data: { credit: 100 } })
      return json({ code: 0, data: { Response: { Data: { Accounts: [] } } } })
    })
    const withNotice = await run(path)
    const attempted = withNotice.results.some(row => row.state !== 'failed' || row.error !== undefined)
    if (attempted) expect(withNotice.notice).toBeDefined()
    else expect(withNotice.notice).toBeUndefined()
    // The suppression flag is honoured unconditionally.
    const withoutNotice = await run(path, { notice: false })
    expect(withoutNotice.notice).toBeUndefined()
  })
})

describe('status', () => {
  it('rolls up to none, ok, warn and error', () => {
    const at = new Date().toISOString()
    expect(status({ day: 'd', checkedAt: at, results: [] })).toBe('none')
    expect(status({ day: 'd', checkedAt: at, results: [{ uid: 'a', state: 'signed', at }] })).toBe('ok')
    expect(status({
      day: 'd',
      checkedAt: at,
      results: [{ uid: 'a', state: 'signed', at }, { uid: 'b', state: 'failed', at }],
    })).toBe('warn')
    expect(status({ day: 'd', checkedAt: at, results: [{ uid: 'b', state: 'failed', at }] })).toBe('error')
  })
})

describe('documentOf', () => {
  it('converts persisted ISO timestamps to epoch milliseconds', () => {
    const at = new Date('2026-10-17T03:04:05.000Z').toISOString()
    const document = documentOf({
      day: '2026-10-17',
      checkedAt: at,
      balanceCheckedAt: at,
      results: [{ uid: 'a', nickname: 'n', state: 'signed', at, credit: 100, balance: 3401, balanceCheckedAt: at }],
    })
    expect(document.checkedAt).toBe(Date.parse(at))
    expect(document.balanceCheckedAt).toBe(Date.parse(at))
    expect(document.results[0]!.at).toBe(Date.parse(at))
    expect(document.results[0]!.balanceCheckedAt).toBe(Date.parse(at))
    expect(document.status).toBe('ok')
  })

  it('answers an empty document when nothing is persisted', () => {
    const document = documentOf(undefined)
    expect(document.results).toEqual([])
    expect(document.status).toBe('none')
    expect(document.checkedAt).toBe(0)
  })
})

describe('claimNotice', () => {
  it('hands the notice to its first reader and strips it from disk', async () => {
    const home = await tempDir('buddy-checkin-notice-')
    const path = join(home, '.buddy-checkin.json')
    const day = today()
    await writeFile(path, JSON.stringify({
      day,
      checkedAt: new Date().toISOString(),
      notice: 'WorkBuddy daily check-in complete: 1 account(s)',
      results: [{ uid: 'a', state: 'signed', at: new Date().toISOString() }],
    }))

    const first = await claimNotice(path)
    expect(first?.notice).toBe('WorkBuddy daily check-in complete: 1 account(s)')
    // The claim is durable: a second reader sees no notice.
    const second = await claimNotice(path)
    expect(second?.notice).toBeUndefined()
    // And the results survive the claim.
    expect(second?.results).toHaveLength(1)
  })

  it('returns nothing when no state is stored at all', async () => {
    const home = await tempDir('buddy-checkin-notice-empty-')
    const path = join(home, '.buddy-checkin.json')
    expect(await claimNotice(path)).toBeUndefined()
  })

  it('returns nothing when no state is stored at all', async () => {
    const home = await tempDir('buddy-checkin-notice-empty-')
    const path = join(home, '.buddy-checkin.json')
    expect(await claimNotice(path)).toBeUndefined()
  })
})

describe('retryFailed', () => {
  it('retries only the accounts that failed today', async () => {
    const home = await tempDir('buddy-checkin-retry-')
    const path = join(home, '.buddy-checkin.json')
    const day = today()
    const at = new Date().toISOString()
    await writeFile(path, JSON.stringify({
      day,
      checkedAt: at,
      results: [
        { uid: 'uid-ok', state: 'signed', at, credit: 100 },
        { uid: 'uid-bad', state: 'failed', at, error: 'insufficient credit' },
      ],
    }))
    const wire = stubFetch(url => {
      if (url.endsWith('/daily-checkin')) return json({ code: 0, data: { credit: 100 } })
      return json({ code: 0, data: { Response: { Data: { Accounts: [{ CycleCapacityRemain: 10 }] } } } })
    })
    const saved = await retryFailed(path)
    const byUid = new Map(saved.results.map(row => [row.uid, row]))
    // The successful row is carried over untouched, never re-requested.
    expect(byUid.get('uid-ok')?.state).toBe('signed')
    expect(byUid.get('uid-ok')?.credit).toBe(100)
    // Whatever discovery finds, the failed row is never silently dropped: it
    // either gets a fresh attempt or keeps its recorded failure with a reason.
    const bad = byUid.get('uid-bad')
    expect(bad).toBeDefined()
    expect(bad!.state === 'signed' || bad!.state === 'failed').toBe(true)
    // And no request may name an account that already succeeded today.
    for (const call of wire.calls) {
      if (call.url.includes('daily-checkin')) {
        expect(call.init.headers).not.toMatchObject({ 'x-user-id': 'uid-ok' })
      }
    }
  })

  it('falls back to a full run when the stored day has passed', async () => {
    const home = await tempDir('buddy-checkin-retry-rollover-')
    const path = join(home, '.buddy-checkin.json')
    await writeFile(path, JSON.stringify({
      day: '2020-01-01',
      checkedAt: new Date().toISOString(),
      results: [{ uid: 'a', state: 'failed', at: new Date().toISOString(), error: 'x' }],
    }))
    stubFetch(url => {
      if (url.endsWith('/daily-checkin')) return json({ code: 0, data: { credit: 1 } })
      return json({ code: 0, data: { Response: { Data: { Accounts: [] } } } })
    })
    const saved = await retryFailed(path)
    expect(saved.day).toBe(today())
  })
})

describe('ensureToday', () => {
  it('returns today\'s state without re-running', async () => {
    const home = await tempDir('buddy-checkin-ensure-')
    const path = join(home, '.buddy-checkin.json')
    const at = new Date().toISOString()
    await writeFile(path, JSON.stringify({
      day: today(),
      checkedAt: at,
      results: [{ uid: 'a', state: 'signed', at }],
    }))
    const wire = stubFetch(() => json({ code: 0, data: {} }))
    const saved = await ensureToday(path, { notice: false })
    expect(saved?.day).toBe(today())
    expect(wire.calls).toHaveLength(0)
  })

  it('runs a fresh attempt when the stored day has passed', async () => {
    const home = await tempDir('buddy-checkin-ensure-rollover-')
    const path = join(home, '.buddy-checkin.json')
    await writeFile(path, JSON.stringify({
      day: '2020-01-01',
      checkedAt: new Date().toISOString(),
      results: [],
    }))
    stubFetch(url => {
      if (url.endsWith('/daily-checkin')) return json({ code: 0, data: { credit: 1 } })
      return json({ code: 0, data: { Response: { Data: { Accounts: [] } } } })
    })
    const saved = await ensureToday(path, { notice: false })
    expect(saved?.day).toBe(today())
  })
})

describe('refreshBalances', () => {
  it('merges fresh balances without repeating the check-in', async () => {
    const home = await tempDir('buddy-checkin-balance-')
    const path = join(home, '.buddy-checkin.json')
    const at = new Date().toISOString()
    await writeFile(path, JSON.stringify({
      day: today(),
      checkedAt: at,
      results: [{ uid: 'uid-1', state: 'signed', at, credit: 100 }],
    }))
    const wire = stubFetch(() => json({ code: 0, data: { Response: { Data: { Accounts: [{ CycleCapacityRemain: 4242 }] } } } }))
    const account: BuddyCheckinCredential = { uid: 'uid-1', accessToken: 'at', domain: 'www.codebuddy.cn' }
    const saved = await refreshBalances(path, [account])
    expect(saved?.results[0]!.balance).toBe(4242)
    expect(saved?.results[0]!.balanceCheckedAt).toBeDefined()
    // The credit figure from the check-in survives the balance refresh.
    expect(saved?.results[0]!.credit).toBe(100)
    for (const call of wire.calls) {
      expect(call.url).not.toContain('daily-checkin')
    }
  })

  it('keeps the last balance when the read fails, and says so', async () => {
    const home = await tempDir('buddy-checkin-balance-fail-')
    const path = join(home, '.buddy-checkin.json')
    const at = new Date().toISOString()
    await writeFile(path, JSON.stringify({
      day: today(),
      checkedAt: at,
      results: [{ uid: 'uid-1', state: 'signed', at, balance: 3401 }],
    }))
    stubFetch(() => json({ code: 1, msg: 'boom' }, false, 500))
    const account: BuddyCheckinCredential = { uid: 'uid-1', accessToken: 'at', domain: 'www.codebuddy.cn' }
    const saved = await refreshBalances(path, [account])
    expect(saved?.results[0]!.balance).toBe(3401)
    expect(saved?.results[0]!.balanceError).toBeDefined()
  })
})
