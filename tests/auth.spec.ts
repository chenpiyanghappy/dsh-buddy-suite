import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkBuddyCredentialStore, parseWorkBuddyAuth } from '../src/auth.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import type { WorkBuddyRefreshOutcome } from '../src/upstream.ts'
import { CN_VARIANT, AI_VARIANT } from '../src/variants.ts'

/**
 * Credential selection: which of the two files wins.
 *
 * This is the most dangerous logic in the plugin. Both files live under one
 * account and can hold *different* accounts — the desktop file is written by the
 * app, the plugin-owned copy by the plugin's own refreshes. Picking the wrong one
 * sends the previous account's identity headers and bills the wrong user.
 *
 * Everything is injected: a temp desktop file, a temp own copy, and a stubbed
 * refresh. Nothing here reads a real registry, a real app directory, or a
 * platform-specific path, so the suite behaves identically on the Ubuntu CI leg.
 */

const FAR_FUTURE = Date.now() + 60 * 60 * 1000
const SOON = Date.now() + 60 * 1000
const PAST = Date.now() - 60 * 1000

/** The desktop document shape the app writes. */
function desktopDocument(options: {
  uid: string
  enterpriseId?: string
  accessToken?: string
  expiresAt?: number
  domain?: string
  refreshToken?: string
}): string {
  return JSON.stringify({
    auth: {
      accessToken: options.accessToken ?? 'desktop-token',
      refreshToken: options.refreshToken ?? 'desktop-refresh',
      expiresAt: options.expiresAt ?? FAR_FUTURE,
      domain: options.domain ?? 'www.workbuddy.cn',
    },
    account: {
      uid: options.uid,
      ...options.enterpriseId === undefined ? {} : { enterpriseId: options.enterpriseId },
    },
  })
}

/** The plugin-owned copy's document shape. */
function ownDocument(credential: {
  uid: string
  enterpriseId?: string
  accessToken?: string
  expiresAtMs?: number
  domain?: string
}): string {
  return JSON.stringify({
    version: 1,
    credential: {
      accessToken: credential.accessToken ?? 'own-token',
      refreshToken: 'own-refresh',
      expiresAtMs: credential.expiresAtMs ?? FAR_FUTURE,
      domain: credential.domain ?? 'www.workbuddy.cn',
      uid: credential.uid,
      ...credential.enterpriseId === undefined ? {} : { enterpriseId: credential.enterpriseId },
      source: 'dsh',
    },
  })
}

interface Harness {
  dir: string
  store: WorkBuddyCredentialStore
  /** Write the desktop file for this harness. */
  desktop: (text: string) => void
  /** Write the plugin-owned copy for this harness. */
  own: (text: string) => void
  /** How many refreshes were attempted. */
  refreshCount: () => number
}

function harness(options: {
  variant?: typeof CN_VARIANT
  refresh?: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>
  withDesktop?: boolean
  withOwn?: boolean
  refreshMarginMs?: number
} = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-suite-auth-'))
  const desktopPath = join(dir, 'desktop-auth.json')
  const ownPath = join(dir, 'own-auth.json')
  let refreshes = 0
  if (options.withDesktop === true) writeFileSync(desktopPath, desktopDocument({ uid: 'desktop-uid' }))
  if (options.withOwn === true) writeFileSync(ownPath, ownDocument({ uid: 'own-uid' }))

  const store = new WorkBuddyCredentialStore({
    variant: options.variant ?? CN_VARIANT,
    desktopPath,
    ownPath,
    refresh: async credential => {
      refreshes += 1
      return options.refresh === undefined
        ? { accessToken: 'refreshed-token', expiresInSec: 3600 }
        : options.refresh(credential)
    },
    ...options.refreshMarginMs === undefined ? {} : { refreshMarginMs: options.refreshMarginMs },
  })

  return {
    dir,
    store,
    desktop: text => { writeFileSync(desktopPath, text) },
    own: text => { writeFileSync(ownPath, text) },
    refreshCount: () => refreshes,
  }
}

function cleanup(h: Harness): void {
  rmSync(h.dir, { recursive: true, force: true })
}

describe('desktop auth document parsing', () => {
  it('reads the nested desktop shape', () => {
    const credential = parseWorkBuddyAuth(desktopDocument({ uid: 'u1', enterpriseId: 'e1' }))
    expect(credential).toMatchObject({ uid: 'u1', enterpriseId: 'e1', domain: 'www.workbuddy.cn', source: 'desktop' })
  })

  it('reads the flat panel shape', () => {
    const credential = parseWorkBuddyAuth(JSON.stringify({
      accessToken: 't',
      refreshToken: 'r',
      expiresAt: FAR_FUTURE,
      domain: 'www.workbuddy.cn',
      uid: 'u2',
    }))
    expect(credential).toMatchObject({ accessToken: 't', uid: 'u2' })
  })

  it('accepts seconds and milliseconds alike', () => {
    const seconds = Math.floor(FAR_FUTURE / 1000)
    const fromSeconds = parseWorkBuddyAuth(JSON.stringify({ accessToken: 't', expiresAt: seconds }))
    const fromMillis = parseWorkBuddyAuth(JSON.stringify({ accessToken: 't', expiresAt: FAR_FUTURE }))
    expect(fromSeconds?.expiresAtMs).toBe(seconds * 1000)
    expect(fromMillis?.expiresAtMs).toBe(FAR_FUTURE)
  })

  it('returns undefined without an access token', () => {
    expect(parseWorkBuddyAuth('{}')).toBeUndefined()
    expect(parseWorkBuddyAuth('not json')).toBeUndefined()
    expect(parseWorkBuddyAuth('[]')).toBeUndefined()
  })

  it('keeps an absent expiry as zero rather than inventing one', () => {
    expect(parseWorkBuddyAuth(JSON.stringify({ accessToken: 't' }))?.expiresAtMs).toBe(0)
  })
})

describe('credential selection', () => {
  it('uses the plugin copy when there is no desktop file', async () => {
    const h = harness({ withOwn: true })
    try {
      h.own(ownDocument({ uid: 'own-uid', accessToken: 'own-token' }))
      expect((await h.store.current())?.accessToken).toBe('own-token')
    } finally { cleanup(h) }
  })

  it('uses the desktop file when there is no plugin copy', async () => {
    const h = harness({ withDesktop: true })
    try {
      h.desktop(desktopDocument({ uid: 'u1', accessToken: 'desktop-token' }))
      expect((await h.store.current())?.accessToken).toBe('desktop-token')
    } finally { cleanup(h) }
  })

  it('prefers the desktop account over a plugin copy of another identity', async () => {
    // Identity beats expiry: the copy may be newer because *this plugin*
    // refreshed the old account, but the app is the authority on who is signed
    // in now.
    const h = harness({ withDesktop: true, withOwn: true })
    try {
      h.desktop(desktopDocument({ uid: 'new-account', accessToken: 'desktop-token', expiresAt: SOON }))
      h.own(ownDocument({ uid: 'old-account', accessToken: 'own-token', expiresAtMs: FAR_FUTURE }))

      const credential = await h.store.current()
      expect(credential?.accessToken).toBe('desktop-token')
      expect(credential?.uid).toBe('new-account')
    } finally { cleanup(h) }
  })

  it('prefers the newer token when both files hold the same identity', async () => {
    const h = harness({ withDesktop: true, withOwn: true })
    try {
      h.desktop(desktopDocument({ uid: 'u1', accessToken: 'desktop-token', expiresAt: SOON }))
      h.own(ownDocument({ uid: 'u1', accessToken: 'own-token', expiresAtMs: FAR_FUTURE }))
      expect((await h.store.current())?.accessToken).toBe('own-token')
    } finally { cleanup(h) }
  })

  it('prefers the desktop token when it is the newer one', async () => {
    const h = harness({ withDesktop: true, withOwn: true })
    try {
      h.desktop(desktopDocument({ uid: 'u1', accessToken: 'desktop-token', expiresAt: FAR_FUTURE }))
      h.own(ownDocument({ uid: 'u1', accessToken: 'own-token', expiresAtMs: SOON }))
      expect((await h.store.current())?.accessToken).toBe('desktop-token')
    } finally { cleanup(h) }
  })

  it('treats a differing enterprise id as a different identity', async () => {
    const h = harness({ withDesktop: true, withOwn: true })
    try {
      h.desktop(desktopDocument({ uid: 'u1', enterpriseId: 'e2', accessToken: 'desktop-token', expiresAt: SOON }))
      h.own(ownDocument({ uid: 'u1', enterpriseId: 'e1', accessToken: 'own-token', expiresAtMs: FAR_FUTURE }))
      expect((await h.store.current())?.accessToken).toBe('desktop-token')
    } finally { cleanup(h) }
  })
})

describe('region mismatch', () => {
  it('refuses a credential belonging to the other product', async () => {
    const h = harness({ withDesktop: true })
    try {
      // A CN provider handed an international credential is a realistic
      // misconfiguration: the two apps share one auth directory.
      h.desktop(desktopDocument({ uid: 'u1', domain: 'www.workbuddy.ai' }))
      await expect(h.store.current()).rejects.toMatchObject({ reasonCode: 'credential-region-mismatch' })
    } finally { cleanup(h) }
  })

  it('names the file and the expected region in the message', async () => {
    const h = harness({ withDesktop: true })
    try {
      h.desktop(desktopDocument({ uid: 'u1', domain: 'www.workbuddy.ai' }))
      await expect(h.store.current()).rejects.toThrow(/www\.workbuddy\.ai/u)
    } finally { cleanup(h) }
  })

  it('accepts the international credential for the international variant', async () => {
    const h = harness({ variant: AI_VARIANT as typeof CN_VARIANT, withDesktop: true })
    try {
      h.desktop(desktopDocument({ uid: 'u1', domain: 'www.workbuddy.ai' }))
      expect((await h.store.current())?.domain).toBe('www.workbuddy.ai')
    } finally { cleanup(h) }
  })

  it('reports the mismatch as a diagnosable signed-out status instead of throwing', async () => {
    // `status()` is documented never to throw; the card renders the reason.
    const h = harness({ withDesktop: true })
    try {
      h.desktop(desktopDocument({ uid: 'u1', domain: 'www.workbuddy.ai' }))
      const status = await h.store.status()
      expect(status.state).toBe('signed-out')
      expect(status.reasonCode).toBe('credential-region-mismatch')
      expect(status.reason).toContain('www.workbuddy.ai')
    } finally { cleanup(h) }
  })
})

describe('missing credentials', () => {
  it('reports nothing current when neither file exists', async () => {
    const h = harness()
    try {
      expect(await h.store.current()).toBeUndefined()
    } finally { cleanup(h) }
  })

  it('throws a diagnosable error from resolve, naming the expected location', async () => {
    const h = harness()
    try {
      await expect(h.store.resolve()).rejects.toThrow(/未找到已登录/u)
      await expect(h.store.resolve()).rejects.toThrow(/(desktop-auth\.json|WORKBUDDY_AUTH_FILE)/u)
    } finally { cleanup(h) }
  })

  it('reports signed-out from status without throwing', async () => {
    const h = harness()
    try {
      const status = await h.store.status()
      expect(status.state).toBe('signed-out')
      expect(status.reasonCode).toBe('no-credential')
    } finally { cleanup(h) }
  })

  it('treats an empty desktop file as absent', async () => {
    // The probe continues past an empty candidate instead of failing.
    const h = harness({ withDesktop: true, withOwn: true })
    try {
      h.desktop('')
      h.own(ownDocument({ uid: 'own-uid', accessToken: 'own-token' }))
      expect((await h.store.current())?.accessToken).toBe('own-token')
    } finally { cleanup(h) }
  })
})

describe('refresh policy', () => {
  it('does not refresh a token that is still comfortably valid', async () => {
    const h = harness({ withDesktop: true, refreshMarginMs: 60_000 })
    try {
      h.desktop(desktopDocument({ uid: 'u1', expiresAt: FAR_FUTURE }))
      await h.store.resolve()
      expect(h.refreshCount()).toBe(0)
    } finally { cleanup(h) }
  })

  it('refreshes a token inside the margin', async () => {
    const h = harness({ withDesktop: true, refreshMarginMs: 60 * 60 * 1000 })
    try {
      h.desktop(desktopDocument({ uid: 'u1', expiresAt: SOON }))
      const credential = await h.store.resolve()
      expect(h.refreshCount()).toBe(1)
      expect(credential.accessToken).toBe('refreshed-token')
    } finally { cleanup(h) }
  })

  it('shares one refresh between concurrent resolves', async () => {
    // Single-flight: a burst of requests must not send a burst of refreshes.
    const h = harness({ withDesktop: true, refreshMarginMs: 60 * 60 * 1000 })
    try {
      h.desktop(desktopDocument({ uid: 'u1', expiresAt: SOON }))
      await Promise.all(Array.from({ length: 5 }, async () => h.store.resolve()))
      expect(h.refreshCount()).toBe(1)
    } finally { cleanup(h) }
  })

  it('keeps a still-valid token when refresh fails', async () => {
    // An unreachable refresh endpoint must not take down a working session.
    const h = harness({
      withDesktop: true,
      refreshMarginMs: 60 * 60 * 1000,
      refresh: async () => { throw new Error('network down') },
    })
    try {
      h.desktop(desktopDocument({ uid: 'u1', accessToken: 'still-good', expiresAt: SOON }))
      const credential = await h.store.resolve()
      expect(credential.accessToken).toBe('still-good')
    } finally { cleanup(h) }
  })

  it('throws when refresh fails and the token has expired', async () => {
    const h = harness({
      withDesktop: true,
      refreshMarginMs: 0,
      refresh: async () => { throw new Error('network down') },
    })
    try {
      h.desktop(desktopDocument({ uid: 'u1', expiresAt: PAST }))
      await expect(h.store.resolve()).rejects.toThrow(/refresh failed/u)
    } finally { cleanup(h) }
  })

  it('throws when an expired token has no refresh token', async () => {
    const h = harness({ withDesktop: true, refreshMarginMs: 0 })
    try {
      h.desktop(desktopDocument({ uid: 'u1', expiresAt: PAST, refreshToken: '' }))
      await expect(h.store.resolve()).rejects.toThrow(/重新登录/u)
    } finally { cleanup(h) }
  })

  it('writes the refreshed credential to the plugin copy, not the desktop file', async () => {
    const h = harness({ withDesktop: true, refreshMarginMs: 60 * 60 * 1000 })
    try {
      const before = desktopDocument({ uid: 'u1', expiresAt: SOON })
      h.desktop(before)
      await h.store.resolve()

      expect(readFileSync(join(h.dir, 'desktop-auth.json'), 'utf8')).toBe(before)
      const own = JSON.parse(readFileSync(join(h.dir, 'own-auth.json'), 'utf8'))
      expect(own.credential.accessToken).toBe('refreshed-token')
    } finally { cleanup(h) }
  })
})

describe('logout', () => {
  it('removes the plugin copy and leaves the desktop file alone', async () => {
    const h = harness({ withDesktop: true, withOwn: true })
    try {
      await h.store.logout()
      expect(existsSync(join(h.dir, 'own-auth.json'))).toBe(false)
      expect(existsSync(join(h.dir, 'desktop-auth.json'))).toBe(true)
    } finally { cleanup(h) }
  })

  it('is safe when there is nothing to remove', async () => {
    const h = harness()
    try {
      await expect(h.store.logout()).resolves.toBeUndefined()
    } finally { cleanup(h) }
  })
})
