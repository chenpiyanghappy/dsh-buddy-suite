import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CN_ELECTRON_PROFILE,
  KeyUnavailableError,
  WorkBuddyAtRestKeyProvider,
  WorkBuddyElectronPathError,
  classifyDesktopAuthDocument,
  deriveProtectorKey,
  keyIdOf,
  keyIdsOf,
  openAuthField,
  parseAtRestPayload,
  parseWrappedField,
  reasonCodeOf,
  resolveElectronPath,
  sealAuthFieldForTest,
  unwrapDesktopAuthDocument,
  type DesktopAuthClassification,
} from '../src/credential/index.ts'

/**
 * Offline specs for the extracted `src/credential/` module.
 *
 * Every byte used here is synthetic: the fixtures under
 * `tests/fixtures/credential/` are sanitized documents with obviously fake
 * tokens, and the encrypted cases are sealed at run time by
 * {@link sealAuthFieldForTest} with a fixture at-rest secret. Nothing spawns
 * the WorkBuddy helper, reads a real credential file, or touches the network;
 * Electron-location cases only assert the failure paths, so no WorkBuddy
 * install is required.
 *
 * The five groups mirror the module's contract: plaintext documents, the
 * at-rest (envelope) decryption path, a missing Electron directory, an
 * envelope whose key id belongs to another install, and enumeration across
 * several accounts.
 */

const FIXTURE_ROOT = fileURLToPath(new URL('./fixtures/credential/', import.meta.url))
const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
  vi.unstubAllEnvs()
})

/** One sanitized fixture's text, by path relative to the fixture root. */
async function fixture(name: string): Promise<string> {
  return await readFile(join(FIXTURE_ROOT, name), 'utf8')
}

/** A temp directory removed after the test. */
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** Validate one fixture payload and derive the key/id exactly as the module does. */
function protectorKeyFrom(payloadText: string): { key: Buffer; keyId: string } {
  const payload = parseAtRestPayload(payloadText)
  if (payload === undefined) throw new Error('fixture at-rest payload is not valid')
  const key = deriveProtectorKey(payload.atRestSecretKey)
  return { key, keyId: keyIdOf(key) }
}

/** A 5.6-shaped auth document whose token fields are synthetic envelopes. */
function encryptedDocument(
  key: Buffer,
  options: { uid?: string; accessToken?: string; refreshToken?: string; suite?: number } = {},
): string {
  const suite = options.suite ?? 1
  return JSON.stringify({
    auth: {
      accessToken: sealAuthFieldForTest(key, options.accessToken ?? 'fixture-encrypted-access-token', suite),
      refreshToken: sealAuthFieldForTest(key, options.refreshToken ?? 'fixture-encrypted-refresh-token', suite),
      domain: 'www.codebuddy.cn',
      expiresAt: 1_800_000_000_000,
    },
    account: {
      uid: options.uid ?? 'fixture-encrypted-uid',
      nickname: 'Fixture Encrypted',
      enterpriseId: '',
    },
  })
}

/** Open every wrapped field, as the credential store does; throws on failure. */
function openDocument(
  classification: Extract<DesktopAuthClassification, { format: 'encrypted' }>,
  key: Buffer,
): Record<string, unknown> {
  const text = unwrapDesktopAuthDocument(classification, field => {
    const plaintext = openAuthField(key, field.envelope)
    if (plaintext === undefined) throw new Error(`cannot open ${field.field}`)
    return plaintext
  })
  return JSON.parse(text) as Record<string, unknown>
}

/** A provider whose key source is stubbed; its spawn seam must never run. */
function providerWithSource(source: () => Promise<string>): WorkBuddyAtRestKeyProvider {
  return new WorkBuddyAtRestKeyProvider({
    product: CN_ELECTRON_PROFILE,
    discovery: 'none',
    source,
    spawnHelper: async () => { throw new Error('the helper must not be spawned') },
  })
}

describe('plaintext desktop auth files (fixture)', () => {
  it('classifies a plaintext fixture without inventing encrypted fields', async () => {
    const text = await fixture('desktop-auth-plaintext.json')
    const classification = classifyDesktopAuthDocument(text)
    expect(classification.format).toBe('plaintext')
    expect(classification).not.toHaveProperty('wrapped')
    const document = JSON.parse(text) as { auth: { accessToken: string }; account: { uid: string } }
    expect(document.auth.accessToken).toBe('fixture-plain-access-token')
    expect(document.account.uid).toBe('fixture-plain-uid')
  })

  it('reads empty, non-object and malformed fixtures as absent/unrecognized', async () => {
    expect(classifyDesktopAuthDocument('')).toEqual({ format: 'absent' })
    expect(classifyDesktopAuthDocument('  \n\t')).toEqual({ format: 'absent' })
    expect(classifyDesktopAuthDocument('not json')).toEqual({ format: 'unrecognized' })
    expect(classifyDesktopAuthDocument('[]')).toEqual({ format: 'unrecognized' })
    const corrupt = await fixture('desktop-auth-unrecognized.json')
    expect(classifyDesktopAuthDocument(corrupt)).toEqual({ format: 'unrecognized' })
  })
})

describe('at-rest decryption path (synthetic envelopes)', () => {
  it('validates the sanitized helper payload and derives a distinct protector key', async () => {
    const payload = parseAtRestPayload(await fixture('at-rest-payload.sanitized.json'))
    expect(payload).toEqual({ atRestSecretKey: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=' })
    const current = protectorKeyFrom(await fixture('at-rest-payload.sanitized.json'))
    const stale = protectorKeyFrom(await fixture('at-rest-payload-stale.sanitized.json'))
    expect(current.key).toHaveLength(32)
    expect(current.keyId).toMatch(/^[0-9a-f]{16}$/u)
    expect(current.keyId).not.toBe(stale.keyId)
  })

  it('rejects payloads the app itself would reject', () => {
    expect(parseAtRestPayload('')).toBeUndefined()
    expect(parseAtRestPayload('{"version":2,"atRestSecretKey":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="}')).toBeUndefined()
    expect(parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: Buffer.alloc(32).toString('base64') }))).toBeUndefined()
    expect(parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: Buffer.alloc(31, 1).toString('base64') }))).toBeUndefined()
    expect(parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: 'not base64!' }))).toBeUndefined()
  })

  it('seals, classifies and opens both token fields with the derived key', async () => {
    const { key, keyId } = protectorKeyFrom(await fixture('at-rest-payload.sanitized.json'))
    const classification = classifyDesktopAuthDocument(encryptedDocument(key))
    expect(classification.format).toBe('encrypted')
    if (classification.format !== 'encrypted') throw new Error('expected an encrypted classification')
    expect(classification.wrapped.fields).toHaveLength(2)
    expect(keyIdsOf(classification.wrapped.fields)).toEqual([keyId])
    const opened = openDocument(classification, key)
    const auth = opened['auth'] as Record<string, unknown>
    expect(auth['accessToken']).toBe('fixture-encrypted-access-token')
    expect(auth['refreshToken']).toBe('fixture-encrypted-refresh-token')
    // Identity and expiry stay in the clear and survive the rebuild untouched.
    expect(auth['domain']).toBe('www.codebuddy.cn')
    expect(auth['expiresAt']).toBe(1_800_000_000_000)
    expect((opened['account'] as Record<string, unknown>)['uid']).toBe('fixture-encrypted-uid')
  })

  it('does not open an envelope sealed by another install', async () => {
    const current = protectorKeyFrom(await fixture('at-rest-payload.sanitized.json'))
    const stale = protectorKeyFrom(await fixture('at-rest-payload-stale.sanitized.json'))
    const classification = classifyDesktopAuthDocument(encryptedDocument(stale.key))
    if (classification.format !== 'encrypted') throw new Error('expected an encrypted classification')
    const field = classification.wrapped.fields[0]
    if (field === undefined) throw new Error('expected at least one wrapped field')
    expect(openAuthField(current.key, field.envelope)).toBeUndefined()
    expect(openAuthField(stale.key, field.envelope)).toBe('fixture-encrypted-access-token')
  })

  it('treats an unknown envelope suite as unrecognized, never as encrypted', async () => {
    const { key } = protectorKeyFrom(await fixture('at-rest-payload.sanitized.json'))
    const wrapper = sealAuthFieldForTest(key, 'fixture-suite-2-token', 2)
    expect(parseWrappedField('accessToken', wrapper)).toBeUndefined()
    expect(classifyDesktopAuthDocument(JSON.stringify({ auth: { accessToken: wrapper } })))
      .toEqual({ format: 'unrecognized' })
  })
})

describe('missing Electron installation (offline)', () => {
  it('reports an explicit env path that is not executable as electron-path-invalid', async () => {
    const missing = join(tmpdir(), 'dsh-buddy-suite-no-such-install', 'WorkBuddy.exe')
    const error = await resolveElectronPath({ WORKBUDDY_ELECTRON_BIN: missing }, 'win32')
      .catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(WorkBuddyElectronPathError)
    expect(error).toBeInstanceOf(KeyUnavailableError)
    expect(reasonCodeOf(error)).toBe('electron-path-invalid')
    expect((error as WorkBuddyElectronPathError).reasonCode).toBe('electron-path-invalid')
    expect((error as Error).message).toContain('WORKBUDDY_ELECTRON_BIN')
  })

  it('refuses a provider with no discovery and no binary without spawning anything', async () => {
    vi.stubEnv('WORKBUDDY_ELECTRON_BIN', '')
    const spawned: string[] = []
    const provider = new WorkBuddyAtRestKeyProvider({
      product: CN_ELECTRON_PROFILE,
      discovery: 'none',
      spawnHelper: async path => {
        spawned.push(path)
        return '{}'
      },
    })
    const error = await provider.protectorKeyFor(['0000000000000000']).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(WorkBuddyElectronPathError)
    expect(reasonCodeOf(error)).toBe('electron-binary-unavailable')
    expect(spawned).toEqual([])
    expect(provider.helperPath()).toBeUndefined()
  })

  it('reports a platform without a default path or discovery as electron-binary-unavailable', async () => {
    const error = await resolveElectronPath({}, 'linux').catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(WorkBuddyElectronPathError)
    expect(reasonCodeOf(error)).toBe('electron-binary-unavailable')
  })
})

describe('envelope key-id matching', () => {
  it('rejects envelopes sealed by a different install with a diagnosable reason code', async () => {
    const current = protectorKeyFrom(await fixture('at-rest-payload.sanitized.json'))
    const stale = protectorKeyFrom(await fixture('at-rest-payload-stale.sanitized.json'))
    const provider = providerWithSource(async () => await fixture('at-rest-payload.sanitized.json'))
    const error = await provider.protectorKeyFor([stale.keyId]).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(WorkBuddyElectronPathError)
    expect(reasonCodeOf(error)).toBe('encrypted-credential-unreadable')
    const message = (error as Error).message
    expect(message).toContain(current.keyId)
    expect(message).toContain(stale.keyId)
  })

  it('single-flights concurrent requests for the same id', async () => {
    const { key, keyId } = protectorKeyFrom(await fixture('at-rest-payload.sanitized.json'))
    let reads = 0
    const provider = providerWithSource(async () => {
      reads += 1
      return await fixture('at-rest-payload.sanitized.json')
    })
    const [first, second] = await Promise.all([
      provider.protectorKeyFor([keyId]),
      provider.protectorKeyFor([keyId]),
    ])
    expect(first).toEqual(key)
    expect(second).toEqual(key)
    expect(reads).toBe(1)
  })

  it('rejects an envelope that names no key id', async () => {
    const provider = providerWithSource(async () => await fixture('at-rest-payload.sanitized.json'))
    const error = await provider.protectorKeyFor([]).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(KeyUnavailableError)
    expect(error).not.toBeInstanceOf(WorkBuddyElectronPathError)
    expect((error as Error).message).toContain('密钥 id')
  })

  it('turns an unusable helper payload into encrypted-credential-unreadable', async () => {
    const provider = providerWithSource(async () => '{"version":2}')
    const error = await provider.protectorKeyFor(['0000000000000000']).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(WorkBuddyElectronPathError)
    expect(reasonCodeOf(error)).toBe('encrypted-credential-unreadable')
  })
})

describe('multi-account enumeration over fixture files', () => {
  it('opens only the accounts sealed by this machine key and skips the rest', async () => {
    const current = protectorKeyFrom(await fixture('at-rest-payload.sanitized.json'))
    const stale = protectorKeyFrom(await fixture('at-rest-payload-stale.sanitized.json'))
    const dir = await tempDir('buddy-credential-accounts-')
    await writeFile(join(dir, 'account-alpha.json'), await fixture('accounts/account-alpha.json'))
    await writeFile(join(dir, 'account-beta.json'), encryptedDocument(current.key, { uid: 'fixture-beta-uid' }))
    await writeFile(join(dir, 'account-gamma.json'), encryptedDocument(stale.key, { uid: 'fixture-gamma-uid' }))

    const files = (await readdir(dir)).filter(name => name.endsWith('.json')).sort()
    expect(files).toEqual(['account-alpha.json', 'account-beta.json', 'account-gamma.json'])

    const opened: { file: string; uid: string; accessToken: string }[] = []
    const skipped: string[] = []
    for (const file of files) {
      const text = await readFile(join(dir, file), 'utf8')
      const classification = classifyDesktopAuthDocument(text)
      if (classification.format === 'plaintext') {
        const document = JSON.parse(text) as { auth: { accessToken: string }; account: { uid: string } }
        opened.push({ file, uid: document.account.uid, accessToken: document.auth.accessToken })
        continue
      }
      if (classification.format !== 'encrypted') {
        skipped.push(file)
        continue
      }
      // The check-in half matches each envelope individually: a backup sealed
      // by another install is skipped, not a reason to fail the whole scan.
      if (!keyIdsOf(classification.wrapped.fields).includes(current.keyId)) {
        skipped.push(file)
        continue
      }
      const document = openDocument(classification, current.key)
      const auth = document['auth'] as Record<string, unknown>
      opened.push({
        file,
        uid: (document['account'] as Record<string, unknown>)['uid'] as string,
        accessToken: auth['accessToken'] as string,
      })
    }

    expect(opened).toEqual([
      { file: 'account-alpha.json', uid: 'fixture-alpha-uid', accessToken: 'fixture-alpha-access-token' },
      { file: 'account-beta.json', uid: 'fixture-beta-uid', accessToken: 'fixture-encrypted-access-token' },
    ])
    expect(skipped).toEqual(['account-gamma.json'])
  })
})
