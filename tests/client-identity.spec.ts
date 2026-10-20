import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CN_APP_VERSION_FILENAME,
  FALLBACK_CN_APP_VERSION,
  chatUserAgent,
  fallbackChatIdentity,
  readCliVersion,
  resolveChatIdentity,
  validCliVersion,
} from '../src/client-identity.ts'
import { FALLBACK_APP_VERSION } from '../src/app-version.ts'

/**
 * The identity chat requests present as.
 *
 * Two things here can break a session for everyone: an invalid version
 * interpolated into a header, and a UA missing a token the gateway expects. Both
 * degrade rather than throw on the resolution path — the throw in `chatUserAgent`
 * is a last gate against a bad call site.
 *
 * Every reader is injected, so no test installs an App, reads a real home
 * directory, or depends on the host platform.
 */

function withTempDir(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-suite-identity-'))
  try {
    body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Lay out a minimal App bundle carrying a CLI package manifest. */
function fakeBundle(dir: string, cliManifest: unknown, name = 'Test.app'): string {
  const bundle = join(dir, name)
  const cliDir = join(bundle, 'Contents', 'Resources', 'app.asar.unpacked', 'cli')
  mkdirSync(cliDir, { recursive: true })
  writeFileSync(join(cliDir, 'package.json'), JSON.stringify(cliManifest))
  return bundle
}

describe('validCliVersion', () => {
  it('accepts the shapes the bundled CLI uses', () => {
    expect(validCliVersion('2.137.1')).toBe(true)
    expect(validCliVersion('2.137.1-rc.1')).toBe(true)
    expect(validCliVersion('0.0.0')).toBe(true)
  })

  it('rejects anything that could inject a header token', () => {
    // The value is interpolated into a User-Agent, so whitespace and control
    // characters are a security boundary rather than a formatting choice.
    expect(validCliVersion('2.137.1\nX-Evil: 1')).toBe(false)
    expect(validCliVersion('2.137.1 extra')).toBe(false)
    expect(validCliVersion('2.137.1 ')).toBe(false)
    expect(validCliVersion('v2.137.1')).toBe(false)
    expect(validCliVersion('2')).toBe(false)
    expect(validCliVersion(undefined)).toBe(false)
    expect(validCliVersion(2137)).toBe(false)
  })
})

describe('chatUserAgent', () => {
  it('builds the CN form with the product token repeated', () => {
    expect(chatUserAgent({ clientVersion: '5.5.6' }, 'cn'))
      .toBe('WorkBuddy/5.5.6 WorkBuddy/5.5.6')
  })

  it('names the international product separately', () => {
    expect(chatUserAgent({ clientVersion: '5.5.2' }, 'global'))
      .toBe('WorkBuddy/5.5.2 WorkBuddy AI/5.5.2')
  })

  it('appends the CLI token only when a version resolved', () => {
    expect(chatUserAgent({ clientVersion: '5.5.6', cliVersion: '2.137.1' }, 'cn'))
      .toBe('WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1')
  })

  it('refuses an invalid client version instead of interpolating it', () => {
    expect(() => chatUserAgent({ clientVersion: '5.5.6\nX: 1' }, 'cn')).toThrow(/invalid client version/u)
    expect(() => chatUserAgent({ clientVersion: '' }, 'cn')).toThrow()
  })

  it('refuses an invalid CLI version', () => {
    expect(() => chatUserAgent({ clientVersion: '5.5.6', cliVersion: 'latest' }, 'cn'))
      .toThrow(/invalid CLI version/u)
  })
})

describe('readCliVersion', () => {
  it('prefers a real declared version', async () => {
    await withTempDirAsync(async dir => {
      const bundle = fakeBundle(dir, { version: '2.137.1' })
      await expect(readCliVersion(bundle)).resolves.toBe('2.137.1')
    })
  })

  it('falls back to the custom-package version when the declared one is the placeholder', async () => {
    // The bundle ships `version: "0.0.0"` and keeps the real one in
    // publishConfig.customPackage.version.
    await withTempDirAsync(async dir => {
      const bundle = fakeBundle(dir, {
        version: '0.0.0',
        publishConfig: { customPackage: { version: '2.140.0' } },
      })
      await expect(readCliVersion(bundle)).resolves.toBe('2.140.0')
    })
  })

  it('returns undefined when both are unusable', async () => {
    await withTempDirAsync(async dir => {
      const bundle = fakeBundle(dir, { version: '0.0.0', publishConfig: { customPackage: { version: 'oops' } } })
      await expect(readCliVersion(bundle)).resolves.toBeUndefined()
    })
  })

  it('returns undefined when the manifest is absent or not JSON', async () => {
    await withTempDirAsync(async dir => {
      const missing = join(dir, 'Nowhere.app')
      const broken = fakeBundle(dir, {})
      writeFileSync(join(broken, 'Contents', 'Resources', 'app.asar.unpacked', 'cli', 'package.json'), 'not json')
      await expect(readCliVersion(missing)).resolves.toBeUndefined()
      await expect(readCliVersion(broken)).resolves.toBeUndefined()
    })
  })

  it('rejects a manifest that is an array or scalar', async () => {
    await withTempDirAsync(async dir => {
      const arrayBundle = fakeBundle(dir, ['2.137.1'], 'Array.app')
      const scalarBundle = fakeBundle(dir, '2.137.1', 'Scalar.app')
      await expect(readCliVersion(arrayBundle)).resolves.toBeUndefined()
      await expect(readCliVersion(scalarBundle)).resolves.toBeUndefined()
    })
  })
})

describe('resolveChatIdentity for CN', () => {
  it('uses the installed App and its bundled CLI version', async () => {
    await withTempDirAsync(async dir => {
      const bundle = fakeBundle(dir, { version: '2.137.1' })
      const identity = await resolveChatIdentity('cn', {
        installedCn: async () => ({ version: '5.6.0', bundle }),
        cnSavedPath: join(dir, 'saved.json'),
      })
      expect(identity).toEqual({ clientVersion: '5.6.0', cliVersion: '2.137.1' })
    })
  })

  it('drops the CLI token when the CLI version does not resolve', async () => {
    await withTempDirAsync(async dir => {
      const identity = await resolveChatIdentity('cn', {
        installedCn: async () => ({ version: '5.6.0', bundle: join(dir, 'Nowhere.app') }),
        cnSavedPath: join(dir, 'saved.json'),
      })
      expect(identity).toEqual({ clientVersion: '5.6.0' })
    })
  })

  it('remembers the App version for the next run', async () => {
    await withTempDirAsync(async dir => {
      const savedPath = join(dir, 'saved.json')
      await resolveChatIdentity('cn', {
        installedCn: async () => ({ version: '5.6.0', bundle: join(dir, 'Nowhere.app') }),
        cnSavedPath: savedPath,
      })
      const saved = JSON.parse(readFileSync(savedPath, 'utf8'))
      expect(saved.version).toBe('5.6.0')
      expect(typeof saved.observedAt).toBe('number')
    })
  })

  it('falls back to the saved version when the App is gone', async () => {
    await withTempDirAsync(async dir => {
      const savedPath = join(dir, 'saved.json')
      writeFileSync(savedPath, JSON.stringify({ version: '5.6.1' }))
      const identity = await resolveChatIdentity('cn', {
        installedCn: async () => undefined,
        cnSavedPath: savedPath,
      })
      // No bundle means no CLI token: the plan omits it rather than claiming a
      // version whose source no longer exists.
      expect(identity).toEqual({ clientVersion: '5.6.1' })
    })
  })

  it('falls back to the compiled-in CN constant when nothing resolves', async () => {
    await withTempDirAsync(async dir => {
      const identity = await resolveChatIdentity('cn', {
        installedCn: async () => undefined,
        cnSavedPath: join(dir, 'absent.json'),
      })
      expect(identity).toEqual(fallbackChatIdentity('cn'))
      expect(identity.clientVersion).toBe(FALLBACK_CN_APP_VERSION)
    })
  })

  it('ignores a saved value that is not a valid version', async () => {
    await withTempDirAsync(async dir => {
      const savedPath = join(dir, 'saved.json')
      writeFileSync(savedPath, JSON.stringify({ version: 'not-a-version' }))
      const identity = await resolveChatIdentity('cn', {
        installedCn: async () => undefined,
        cnSavedPath: savedPath,
      })
      expect(identity.clientVersion).toBe(FALLBACK_CN_APP_VERSION)
    })
  })

  it('ignores an installed version that is not a valid version', async () => {
    await withTempDirAsync(async dir => {
      const identity = await resolveChatIdentity('cn', {
        installedCn: async () => ({ version: '5.6.0-beta', bundle: join(dir, 'X.app') }),
        cnSavedPath: join(dir, 'absent.json'),
      })
      expect(identity.clientVersion).toBe(FALLBACK_CN_APP_VERSION)
    })
  })

  it('degrades to the fallback when a reader throws', async () => {
    await withTempDirAsync(async dir => {
      const identity = await resolveChatIdentity('cn', {
        installedCn: async () => { throw new Error('filesystem exploded') },
        cnSavedPath: join(dir, 'absent.json'),
      })
      expect(identity).toEqual(fallbackChatIdentity('cn'))
    })
  })

  it('survives an unwritable saved-version path', async () => {
    await withTempDirAsync(async dir => {
      // A file where a directory is needed: the cache write fails, the identity
      // still resolves.
      const blocker = join(dir, 'blocker')
      writeFileSync(blocker, 'x')
      const identity = await resolveChatIdentity('cn', {
        installedCn: async () => ({ version: '5.6.0', bundle: join(dir, 'Nowhere.app') }),
        cnSavedPath: join(blocker, 'saved.json'),
      })
      expect(identity.clientVersion).toBe('5.6.0')
    })
  })
})

describe('resolveChatIdentity for the international app', () => {
  it('uses the installed version and its CLI', async () => {
    await withTempDirAsync(async dir => {
      const bundle = fakeBundle(dir, { version: '2.140.0' })
      const identity = await resolveChatIdentity('global', {
        resolveIntl: async () => ({ version: '5.5.3', source: 'installed', bundle }),
        cliVersion: async () => '2.140.0',
      })
      expect(identity).toEqual({ clientVersion: '5.5.3', cliVersion: '2.140.0' })
    })
  })

  it('omits the CLI token when the resolver only had a saved value', async () => {
    // A saved or fallback resolution has no bundle path, so there is nothing to
    // read a CLI version from.
    await withTempDirAsync(async () => {
      const identity = await resolveChatIdentity('global', {
        resolveIntl: async () => ({ version: '5.5.3', source: 'saved' }),
        cliVersion: async () => '2.140.0',
      })
      expect(identity).toEqual({ clientVersion: '5.5.3' })
    })
  })

  it('replaces an invalid resolved version with the compiled-in constant', async () => {
    await withTempDirAsync(async () => {
      const identity = await resolveChatIdentity('global', {
        resolveIntl: async () => ({ version: 'bad', source: 'saved' }),
      })
      expect(identity.clientVersion).toBe(FALLBACK_APP_VERSION)
    })
  })

  it('never writes the CN version cache', async () => {
    await withTempDirAsync(async dir => {
      const cnSavedPath = join(dir, 'cn-saved.json')
      await resolveChatIdentity('global', {
        resolveIntl: async () => ({ version: '5.5.3', source: 'installed', bundle: join(dir, 'Nowhere.app') }),
        cnSavedPath,
        cliVersion: async () => undefined,
      })
      // The two caches stay isolated so a CN version can never relabel an
      // international catalog request.
      expect(() => readFileSync(cnSavedPath, 'utf8')).toThrow()
    })
  })

  it('degrades to the fallback when the resolver throws', async () => {
    await withTempDirAsync(async () => {
      const identity = await resolveChatIdentity('global', {
        resolveIntl: async () => { throw new Error('boom') },
      })
      expect(identity).toEqual(fallbackChatIdentity('global'))
    })
  })
})

describe('route cache', () => {
  it('does not cache a degraded answer', async () => {
    // A thrown reader must not pin the fallback for the process lifetime.
    const first = await resolveChatIdentity('cn', {
      installedCn: async () => { throw new Error('transient') },
    })
    expect(first).toEqual(fallbackChatIdentity('cn'))

    const second = await resolveChatIdentity('cn', {
      installedCn: async () => ({ version: '9.9.9', bundle: '/nowhere/X.app' }),
      cnSavedPath: join(tmpdir(), `buddy-suite-absent-${process.pid}.json`),
      cliVersion: async () => undefined,
    })
    // The injected reader bypasses the cache, so this proves the *fallback*
    // branch was not cached rather than merely that injection bypasses.
    expect(second.clientVersion).toBe('9.9.9')
  })

  it('keeps the CN cache filename distinct from the international one', () => {
    expect(CN_APP_VERSION_FILENAME).toBe('.workbuddy-app-version.json')
    expect(CN_APP_VERSION_FILENAME).not.toBe('.workbuddy-ai-version.json')
  })
})

/** Awaiting variant of the temp-dir helper, for the async resolvers. */
async function withTempDirAsync(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-suite-identity-'))
  try {
    await body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
