import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workBuddyWebStatus } from '../src/web-status.ts'
import { run, stripDiagnosticSecrets } from '../src/bin.ts'
import type { WorkBuddyCredentialStore } from '../src/auth.ts'
import type { WorkBuddyUpstreamClient } from '../src/upstream.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import type { WorkBuddyWebCatalog } from '../src/status-paths.ts'

/**
 * T2 health-check status routing, offline.
 *
 * Two surfaces are covered: the same-origin status document the card renders
 * (tri-state + classified error), and the boot-free `status` / `doctor` CLI
 * (`--json` tri-state plus the no-secret guarantee). `fetch` is stubbed
 * everywhere; the credential files live in a temp directory.
 */

const CLEANUP: (() => Promise<void>)[] = []
const STDOUT_CAPTURES: (() => void)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
  for (const restore of STDOUT_CAPTURES.splice(0)) restore()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

/** A fresh temp directory, removed after the test. */
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** The desktop auth document shape the store parses. */
function authDocument(accessToken: string): string {
  return JSON.stringify({
    auth: { accessToken, domain: 'www.codebuddy.cn', expiresAt: 4_102_444_800 },
    account: { uid: 'uid-1', nickname: 'tester', enterpriseId: '' },
  })
}

/** Capture everything the CLI writes to stdout. */
function captureStdout(): { text: () => string } {
  const chunks: string[] = []
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((
    chunk: string | Uint8Array,
  ): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }) as typeof process.stdout.write)
  STDOUT_CAPTURES.push(() => spy.mockRestore())
  return { text: () => chunks.join('') }
}

/** A JSON envelope response for a stubbed fetch. */
function envelope(body: unknown, ok = true, status = 200): Response {
  const text = JSON.stringify(body)
  return {
    ok,
    status,
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(body),
  } as unknown as Response
}

/** A non-JSON response: the shape a protocol change produces. */
function html(status = 200): Response {
  return {
    ok: true,
    status,
    text: () => Promise.resolve('<html>gateway error</html>'),
    json: () => Promise.reject(new SyntaxError('Unexpected token <')),
  } as unknown as Response
}

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'at',
  refreshToken: '',
  expiresAtMs: 4_102_444_800_000,
  domain: 'www.codebuddy.cn',
  uid: 'uid-1',
  source: 'desktop',
}

const SIGNED_IN = {
  state: 'signed-in' as const,
  nickname: 'tester',
  domain: 'www.codebuddy.cn',
  source: 'desktop' as const,
  expiresAtMs: 4_102_444_800_000,
}

/** Status-route dependencies over a fake store and a chosen credit answer. */
function statusDeps(options: {
  auth?: unknown
  credential?: WorkBuddyCredential | undefined
  fetchCredits?: () => Promise<never | unknown>
  catalog?: WorkBuddyWebCatalog
}): Parameters<typeof workBuddyWebStatus>[0] {
  return {
    store: {
      status: async () => options.auth ?? SIGNED_IN,
      current: async () => options.credential ?? CREDENTIAL,
    } as unknown as WorkBuddyCredentialStore,
    client: {
      fetchCredits: options.fetchCredits ?? (async () => ({ total: 42, accounts: [] })),
    } as unknown as Pick<WorkBuddyUpstreamClient, 'fetchCredits'>,
    models: () => [],
    ...options.catalog === undefined ? {} : { catalog: () => options.catalog! },
  }
}

describe('the status document reports the tri-state', () => {
  it('is plugin_ok when the credential and the credit read both work', async () => {
    const document = await workBuddyWebStatus(statusDeps({}))
    expect(document.status).toBe('signed-in')
    expect(document.health).toBe('plugin_ok')
    expect(document.lastError).toBeUndefined()
  })

  it('is credential_invalid when no usable credential exists', async () => {
    const document = await workBuddyWebStatus(statusDeps({
      auth: { state: 'signed-out', reason: 'the encrypted field could not be opened', reasonCode: 'encrypted-credential-unreadable' },
      credential: undefined,
    }))
    expect(document.status).toBe('signed-out')
    expect(document.health).toBe('credential_invalid')
    expect(document.lastError?.code).toBe('CREDENTIAL_DECRYPT_FAILED')
    expect(document.lastError?.stage).toBe('credential')
  })

  it('is upstream_changed when the upstream answers in an unreadable shape', async () => {
    const document = await workBuddyWebStatus(statusDeps({
      fetchCredits: async () => { throw new Error('workbuddy upstream returned non-JSON (http 200): <html>') },
    }))
    expect(document.status).toBe('signed-in')
    expect(document.health).toBe('upstream_changed')
    expect(document.lastError?.code).toBe('UPSTREAM_PROTOCOL_CHANGED')
    expect(document.lastError?.stage).toBe('credits')
    // The account figures still render: one failed read must not blank the card.
    expect(document.status === 'signed-in' && document.creditsError).toContain('non-JSON')
  })

  it('is upstream_changed when the credit transport fails', async () => {
    const document = await workBuddyWebStatus(statusDeps({
      fetchCredits: async () => { throw new TypeError('fetch failed') },
    }))
    expect(document.health).toBe('upstream_changed')
    expect(document.lastError?.code).toBe('UPSTREAM_UNREACHABLE')
  })

  it('is upstream_changed when only the catalog is stale', async () => {
    const document = await workBuddyWebStatus(statusDeps({
      catalog: { source: 'fallback', error: 'workbuddy upstream returned non-JSON (http 200)' },
    }))
    expect(document.health).toBe('upstream_changed')
    expect(document.lastError?.stage).toBe('catalog')
    expect(document.lastError?.code).toBe('UPSTREAM_PROTOCOL_CHANGED')
  })

  it('reports credential_invalid when the credit read is rejected as a dead session', async () => {
    const document = await workBuddyWebStatus(statusDeps({
      fetchCredits: async () => { throw new Error('workbuddy upstream session_dead (http 401): Offline user session not found') },
    }))
    expect(document.health).toBe('credential_invalid')
    expect(document.lastError?.code).toBe('CREDENTIAL_MISSING')
  })

  it('moves between the three states as the underlying facts change', async () => {
    // The tri-state is computed per read, not cached: a sign-in, a fresh
    // upstream shape failure, and a recovery each have to show up on the next
    // document without a process restart.
    let signedIn = false
    let creditsFail = false
    const deps = {
      store: {
        status: async () => signedIn ? SIGNED_IN : { state: 'signed-out' as const, reasonCode: 'no-credential' as const },
        current: async () => signedIn ? CREDENTIAL : undefined,
      } as unknown as WorkBuddyCredentialStore,
      client: {
        fetchCredits: async () => {
          if (creditsFail) throw new Error('workbuddy upstream returned non-JSON (http 200): <html>')
          return { total: 1, accounts: [] }
        },
      } as unknown as Pick<WorkBuddyUpstreamClient, 'fetchCredits'>,
      models: () => [],
    }

    expect((await workBuddyWebStatus(deps)).health).toBe('credential_invalid')
    signedIn = true
    expect((await workBuddyWebStatus(deps)).health).toBe('plugin_ok')
    creditsFail = true
    expect((await workBuddyWebStatus(deps)).health).toBe('upstream_changed')
    creditsFail = false
    expect((await workBuddyWebStatus(deps)).health).toBe('plugin_ok')
  })
})

describe('stripDiagnosticSecrets', () => {
  it('removes probeKey, token, and key material at any depth', () => {
    const stripped = stripDiagnosticSecrets({
      schemaVersion: 1,
      probeKey: 'control-secret',
      accessToken: 'access-secret',
      nested: { refreshToken: 'refresh-secret', atRestSecretKey: 'at-rest-secret', ok: true },
      list: [{ token: 'list-secret' }, 'access_token=inline-secret&x=1'],
      message: 'request failed?access_token=query-secret&code=401',
    })
    const text = JSON.stringify(stripped)
    expect(text).not.toContain('control-secret')
    expect(text).not.toContain('access-secret')
    expect(text).not.toContain('refresh-secret')
    expect(text).not.toContain('at-rest-secret')
    expect(text).not.toContain('list-secret')
    expect(text).not.toContain('inline-secret')
    expect(text).not.toContain('query-secret')
    expect(stripped).toMatchObject({ schemaVersion: 1, nested: { ok: true } })
    expect('probeKey' in (stripped as Record<string, unknown>)).toBe(false)
  })
})

/**
 * CLI specs. Each one points the CN variant's desktop auth file at a temp
 * document, so no real credential on the machine is read.
 */
async function cliEnvironment(content: string | undefined): Promise<void> {
  const home = await tempDir('buddy-status-home-')
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('WORKBUDDY_AUTH_FILE', content === undefined ? join(home, 'missing-auth.info') : join(home, 'workbuddy-desktop.info'))
  if (content !== undefined) await writeFile(join(home, 'workbuddy-desktop.info'), content)
}

describe('the status command reports the tri-state in --json', () => {
  it('plugin_ok with a valid sign-in and a readable credit balance', async () => {
    await cliEnvironment(authDocument('ACCESS-TOKEN-SHOULD-NOT-APPEAR'))
    vi.stubGlobal('fetch', vi.fn(async () => envelope({
      code: 0,
      data: { Response: { Data: { Accounts: [{ CycleCapacityRemain: 4242 }] } } },
    })))
    const out = captureStdout()
    const code = await run(['status', '--json'])
    const document = JSON.parse(out.text()) as Record<string, unknown>

    expect(code).toBe(0)
    expect(document['health']).toBe('plugin_ok')
    expect(document['credits']).toBe(4242)
    // The diagnostics document is pasteable: no session material, no key.
    expect(out.text()).not.toContain('ACCESS-TOKEN-SHOULD-NOT-APPEAR')
    expect(out.text()).not.toContain('probeKey')
    expect('lastError' in document).toBe(false)
  })

  it('upstream_changed when the upstream no longer answers in a known shape', async () => {
    await cliEnvironment(authDocument('ACCESS-TOKEN-SHOULD-NOT-APPEAR'))
    vi.stubGlobal('fetch', vi.fn(async () => html()))
    const out = captureStdout()
    const code = await run(['status', '--json'])
    const document = JSON.parse(out.text()) as Record<string, unknown>

    expect(code).toBe(0)
    expect(document['status']).toBe('signed-in')
    expect(document['health']).toBe('upstream_changed')
    expect(document['lastError']).toMatchObject({ stage: 'credits', code: 'UPSTREAM_PROTOCOL_CHANGED' })
    expect(out.text()).not.toContain('ACCESS-TOKEN-SHOULD-NOT-APPEAR')
  })

  it('credential_invalid when no usable credential exists', async () => {
    await cliEnvironment(undefined)
    const out = captureStdout()
    const code = await run(['status', '--json'])
    const document = JSON.parse(out.text()) as Record<string, unknown>

    expect(code).toBe(1)
    expect(document['status']).toBe('signed-out')
    expect(document['health']).toBe('credential_invalid')
    expect(document['lastError']).toMatchObject({ stage: 'credential', code: 'CREDENTIAL_MISSING' })
    expect(out.text()).not.toContain('probeKey')
  })
})

describe('the doctor command reports the tri-state it can prove offline', () => {
  it('plugin_ok when signed in with a readable desktop file', async () => {
    await cliEnvironment(authDocument('ACCESS-TOKEN-SHOULD-NOT-APPEAR'))
    const out = captureStdout()
    const code = await run(['doctor', '--json'])
    const document = JSON.parse(out.text()) as Record<string, unknown>

    expect(code).toBe(0)
    expect(document['health']).toBe('plugin_ok')
    expect(document['signIn']).toBe('signed-in')
    expect(out.text()).not.toContain('ACCESS-TOKEN-SHOULD-NOT-APPEAR')
  })

  it('upstream_changed when the desktop product changed its file format', async () => {
    // Not JSON at all: the format this plugin knows neither plaintext nor its
    // encrypted shape. No credential fix can undo that — the upstream moved.
    await cliEnvironment('{not-json')
    const out = captureStdout()
    const code = await run(['doctor', '--json'])
    const document = JSON.parse(out.text()) as Record<string, unknown>

    expect(code).toBe(1)
    expect(document['health']).toBe('upstream_changed')
    expect(document['desktopAuthFile']).toMatchObject({ present: true, format: 'unrecognized' })
  })

  it('credential_invalid when no credential file exists', async () => {
    await cliEnvironment(undefined)
    const out = captureStdout()
    const code = await run(['doctor', '--json'])
    const document = JSON.parse(out.text()) as Record<string, unknown>

    expect(code).toBe(1)
    expect(document['health']).toBe('credential_invalid')
  })
})
