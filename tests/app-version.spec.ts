import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FALLBACK_APP_VERSION,
  WORKBUDDY_APP_VERSION_FILENAME,
  appUserAgent,
  appVersionPath,
  readBundleVersion,
  resolveAppVersion,
  validAppVersion,
} from '../src/app-version.ts'

/**
 * The international App-version chain: installed → saved → compiled-in.
 *
 * The version reaches two places that matter: the `/v3/config` User-Agent that
 * decides whether the App-shaped catalog is served at all, and the chat
 * identity's `X-IDE-Version`. It must never be the reason a request fails, so
 * every failure degrades instead of throwing.
 *
 * All filesystem access is injected into a temp directory; nothing here reads a
 * real App bundle or a real home directory.
 */

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-suite-appversion-'))
  try {
    await body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** An Info.plist carrying the short version the way macOS writes it. */
function plist(version: string, otherKey = '1.0.0'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.example.app</string>
  <key>CFBundleVersion</key>
  <string>${otherKey}</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
</dict>
</plist>`
}

describe('validAppVersion', () => {
  it('accepts the shapes the App ships', () => {
    expect(validAppVersion('5.5.2')).toBe(true)
    expect(validAppVersion('5.5')).toBe(true)
    expect(validAppVersion('5.5.2.1')).toBe(true)
  })

  it('rejects values that are not a bare dotted version', () => {
    // This string is interpolated into an HTTP header.
    expect(validAppVersion('5')).toBe(false)
    expect(validAppVersion('5.5.2-rc.2')).toBe(false)
    expect(validAppVersion('v5.5.2')).toBe(false)
    expect(validAppVersion('5.5.2 ')).toBe(false)
    expect(validAppVersion('5.5.2\nX-Evil: 1')).toBe(false)
    expect(validAppVersion(undefined)).toBe(false)
    expect(validAppVersion(552)).toBe(false)
  })
})

describe('readBundleVersion', () => {
  it('reads the short version out of the plist', async () => {
    await withTempDir(async dir => {
      const path = join(dir, 'Info.plist')
      writeFileSync(path, plist('5.5.3'))
      await expect(readBundleVersion(path)).resolves.toBe('5.5.3')
    })
  })

  it('is not fooled by an unrelated key holding a version-shaped string', async () => {
    // Parsed as XML rather than grepped precisely so the neighbouring
    // CFBundleVersion cannot be returned instead.
    await withTempDir(async dir => {
      const path = join(dir, 'Info.plist')
      writeFileSync(path, plist('5.5.3', '9.9.9'))
      await expect(readBundleVersion(path)).resolves.toBe('5.5.3')
    })
  })

  it('returns undefined for a missing file', async () => {
    await withTempDir(async dir => {
      await expect(readBundleVersion(join(dir, 'absent.plist'))).resolves.toBeUndefined()
    })
  })

  it('returns undefined for a binary or non-XML plist', async () => {
    await withTempDir(async dir => {
      const path = join(dir, 'Info.plist')
      writeFileSync(path, Buffer.from([0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30]))
      await expect(readBundleVersion(path)).resolves.toBeUndefined()
    })
  })

  it('returns undefined when the key holds an invalid version', async () => {
    await withTempDir(async dir => {
      const path = join(dir, 'Info.plist')
      writeFileSync(path, plist('not-a-version'))
      await expect(readBundleVersion(path)).resolves.toBeUndefined()
    })
  })

  it('returns undefined when the key is absent', async () => {
    await withTempDir(async dir => {
      const path = join(dir, 'Info.plist')
      writeFileSync(path, '<plist><dict><key>Other</key><string>5.5.2</string></dict></plist>')
      await expect(readBundleVersion(path)).resolves.toBeUndefined()
    })
  })
})

describe('resolveAppVersion', () => {
  it('uses the installed version and reports its provenance', async () => {
    await withTempDir(async dir => {
      const info = await resolveAppVersion({
        installed: async () => ({ version: '5.5.3', bundle: '/Applications/WorkBuddy AI.app' }),
        path: join(dir, 'version.json'),
      })
      expect(info).toMatchObject({ version: '5.5.3', source: 'installed', bundle: '/Applications/WorkBuddy AI.app' })
    })
  })

  it('writes the installed version back for later runs', async () => {
    await withTempDir(async dir => {
      const path = join(dir, 'version.json')
      await resolveAppVersion({
        installed: async () => ({ version: '5.5.3', bundle: '/Applications/WorkBuddy AI.app' }),
        path,
      })
      const saved = JSON.parse(readFileSync(path, 'utf8'))
      expect(saved.version).toBe('5.5.3')
      expect(saved.bundle).toBe('/Applications/WorkBuddy AI.app')
    })
  })

  it('falls back to the saved version when the App is gone', async () => {
    await withTempDir(async dir => {
      const path = join(dir, 'version.json')
      writeFileSync(path, JSON.stringify({ version: '5.5.1' }))
      const info = await resolveAppVersion({ installed: async () => undefined, path })
      expect(info).toEqual({ version: '5.5.1', source: 'saved' })
    })
  })

  it('falls back to the compiled-in constant when nothing is available', async () => {
    await withTempDir(async dir => {
      const info = await resolveAppVersion({ installed: async () => undefined, path: join(dir, 'absent.json') })
      expect(info).toEqual({ version: FALLBACK_APP_VERSION, source: 'fallback' })
    })
  })

  it('ignores a corrupt cache rather than failing the catalog request', async () => {
    await withTempDir(async dir => {
      const path = join(dir, 'version.json')
      writeFileSync(path, '}{')
      const info = await resolveAppVersion({ installed: async () => undefined, path })
      expect(info.source).toBe('fallback')
    })
  })

  it('ignores a saved value that is not a valid version', async () => {
    await withTempDir(async dir => {
      const path = join(dir, 'version.json')
      writeFileSync(path, JSON.stringify({ version: 'latest' }))
      const info = await resolveAppVersion({ installed: async () => undefined, path })
      expect(info.source).toBe('fallback')
    })
  })

  it('ignores an installed version that is not valid', async () => {
    await withTempDir(async dir => {
      const info = await resolveAppVersion({
        installed: async () => ({ version: 'v5.5.3', bundle: '/x.app' }),
        path: join(dir, 'absent.json'),
      })
      expect(info.source).toBe('fallback')
    })
  })

  it('survives an unwritable cache path', async () => {
    // A read-only home is not a reason to serve no catalog.
    await withTempDir(async dir => {
      const blocker = join(dir, 'blocker')
      writeFileSync(blocker, 'x')
      const info = await resolveAppVersion({
        installed: async () => ({ version: '5.5.3', bundle: '/x.app' }),
        path: join(blocker, 'version.json'),
      })
      expect(info.version).toBe('5.5.3')
    })
  })
})

describe('appUserAgent', () => {
  it('builds the terse form the gateway accepts', () => {
    // The space form is rejected with 400/12403; this shape is the one measured
    // to return the App document.
    expect(appUserAgent('5.5.2')).toBe('WorkBuddyAI/5.5.2')
    expect(appUserAgent('5.5.2')).not.toContain(' ')
  })

  it('refuses an invalid version instead of sending a malformed header', () => {
    expect(() => appUserAgent('5.5.2-rc.2')).toThrow(/invalid WorkBuddy AI version/u)
    expect(() => appUserAgent('')).toThrow()
  })
})

describe('appVersionPath', () => {
  it('points at the international cache filename', () => {
    expect(WORKBUDDY_APP_VERSION_FILENAME).toBe('.workbuddy-ai-version.json')
    expect(appVersionPath().endsWith(WORKBUDDY_APP_VERSION_FILENAME)).toBe(true)
  })
})
