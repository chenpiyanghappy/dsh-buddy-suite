/**
 * WorkBuddy 5.6+ at-rest credential envelopes (`$wbEncrypted`): classification,
 * key resolution, and field decryption for the desktop app's encrypted auth
 * files.
 *
 * Since WorkBuddy 5.6 the desktop app encrypts `auth.accessToken`,
 * `auth.refreshToken` and `account.nickname` at rest
 * (`buildPolicy: "fields"`, on by default), so the plugin reads
 * `{$wbEncrypted:1, envelope}` wrappers instead of token strings. Everything
 * needed to open them lives on the same machine:
 *
 * - the sealed payload (`{version:1, atRestSecretKey}`) comes from the
 *   WorkBuddy-modified Electron's private `workbuddyStorage` binding, reached
 *   by running *its own* binary once with `ELECTRON_RUN_AS_NODE=1`;
 * - `protectorKey = sha256(atRestSecretKey, utf8)` opens the envelopes with
 *   AES-256-GCM; the AAD builder below is transcribed from the app's own
 *   `buildAuthenticatedContextAad`.
 *
 * The plugin process itself can never call `_linkedBinding` (it runs in DSH's
 * Node, not the forked Electron), so the helper is spawned. The key is cached
 * in memory only, single-flight, and re-resolved when an envelope names a
 * different key id. Neither the payload, the key, nor any token is ever
 * logged; error messages carry sizes, ids, and exit codes only.
 *
 * Two callers share this module and deliberately differ in how they use the
 * resolved key:
 *
 * - the **model provider** (single current credential) must open the current
 *   document or fail loudly, so it enforces the envelope's key id;
 * - the **check-in** (every historical account) matches each envelope
 *   individually, because a backup sealed by a previous install must be
 *   skipped rather than failing the whole scan.
 *
 * Both shapes are therefore exported: {@link WorkBuddyAtRestKeyProvider} for
 * the provider's strict resolution, and the plain {@link protectorKey}
 * resolver the scanner uses.
 *
 * @module dsh-buddy-suite/desktop-credential-protection
 */

import { execFile } from 'node:child_process'
import { accessSync, constants, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { release } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  AI_ELECTRON_PROFILE,
  CN_ELECTRON_PROFILE,
  electronProfileFor,
  type WorkBuddyElectronProduct,
  type WorkBuddyVariant,
} from './variants.ts'
import type { WorkBuddySignedOutReasonCode } from './status-paths.ts'

/** The four states a desktop auth document can be read as. */
export type DesktopAuthFormat = 'absent' | 'plaintext' | 'encrypted' | 'unrecognized'

/**
 * The product profiles and the CN env var are declared in `variants.ts` and
 * re-exported here so callers that only need decryption have one import site.
 * The type is re-exported too, because every signature below names it.
 */
export {
  AI_ELECTRON_PROFILE,
  CN_ELECTRON_PROFILE,
  WORKBUDDY_ELECTRON_BIN_ENV,
} from './variants.ts'
export type { WorkBuddyElectronProduct } from './variants.ts'

/** One decrypted-openable envelope's decoded parts. */
export interface WorkBuddyEnvelope {
  suite: number
  keyId: string
  nonce: Buffer
  authTag: Buffer
  ciphertext: Buffer
}

/** One auth field found in its encrypted wrapper, with its envelope decoded. */
export interface WrappedAuthField {
  field: 'accessToken' | 'refreshToken'
  envelope: WorkBuddyEnvelope
}

/**
 * A read desktop auth document, as a discriminated union on `format`. The
 * `encrypted` variant carries the parsed document plus the fields still in
 * wrappers; the caller decrypts those fields and hands the rebuilt text to
 * the regular parser, so identity and expiry fields need no second code path.
 */
export type DesktopAuthClassification =
  | { format: 'absent' }
  | { format: 'plaintext' }
  | { format: 'encrypted', wrapped: { document: Record<string, unknown>, fields: readonly WrappedAuthField[] } }
  | { format: 'unrecognized' }

/** Distinct key ids across the wrapped fields, in field order. */
export function keyIdsOf(fields: readonly WrappedAuthField[]): string[] {
  return [...new Set(fields.map(wrapped => wrapped.envelope.keyId))]
}

/**
 * The platform-default Electron binary for one product, or `undefined` where
 * none is verified.
 */
export function defaultWorkBuddyElectronPath(
  product: WorkBuddyElectronProduct,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === 'darwin') return product.macOS.defaultPath
  if (platform !== 'win32' || product.windows.defaultPathSegments === undefined) return undefined
  const localAppData = process.env.LOCALAPPDATA?.trim()
  return localAppData === undefined || localAppData === ''
    ? undefined
    : join(localAppData, ...product.windows.defaultPathSegments)
}

/** Decode a base64 value and check its exact byte length when given. */
function parseBase64(value: unknown, length?: number): Buffer | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  let decoded: Buffer
  try {
    decoded = Buffer.from(value, 'base64')
  } catch {
    return undefined
  }
  // Buffer.from is lenient about stray characters; require the round-trip so a
  // tampered envelope is rejected before any key material is involved.
  if (decoded.length === 0 || decoded.toString('base64').replace(/=+$/u, '') !== value.replace(/=+$/u, '')) return undefined
  return length === undefined || decoded.length === length ? decoded : undefined
}

/**
 * Whether a raw value is the 5.6 field wrapper, with its inner envelope
 * decodable. The wrapper is `{$wbEncrypted:1, envelope:<base64 of a JSON
 * {suite,keyId,nonce,authTag,ciphertext>}`; anything claiming the flag whose
 * envelope cannot be decoded makes the whole document unrecognized rather
 * than encrypted, because no key could ever open it.
 */
export function parseWrappedField(field: 'accessToken' | 'refreshToken', value: unknown): WrappedAuthField | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const wrapped = value as Record<string, unknown>
  if (wrapped['$wbEncrypted'] !== 1 || typeof wrapped['envelope'] !== 'string') return undefined
  let inner: unknown
  try {
    inner = JSON.parse(Buffer.from(wrapped['envelope'], 'base64').toString('utf8'))
  } catch {
    return undefined
  }
  if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) return undefined
  const parts = inner as Record<string, unknown>
  const nonce = parseBase64(parts['nonce'], 12)
  const authTag = parseBase64(parts['authTag'], 16)
  const ciphertext = parseBase64(parts['ciphertext'])
  if (nonce === undefined || authTag === undefined || ciphertext === undefined) return undefined
  if (typeof parts['suite'] !== 'number' || !Number.isInteger(parts['suite'])) return undefined
  // Suite 1 is the only scheme WorkBuddy 5.6.x defines for credential fields.
  // Anything else is a format this plugin has not seen, so the wrapper is not
  // claimed as encrypted — the document then reads as unrecognized and the
  // store reports a diagnosis instead of attempting a blind open.
  if (parts['suite'] !== 1) return undefined
  if (typeof parts['keyId'] !== 'string' || !/^[0-9a-f]{16}$/u.test(parts['keyId'])) return undefined
  return {
    field,
    envelope: {
      suite: parts['suite'],
      keyId: parts['keyId'],
      nonce,
      authTag,
      ciphertext,
    },
  }
}

const AUTH_FIELDS = ['accessToken', 'refreshToken'] as const

/**
 * Read a desktop auth document's format. `absent` is an empty file; `plaintext`
 * is any document the regular parser could read (even one without a token);
 * `encrypted` has at least one field in a decodable wrapper; everything else —
 * unparsable JSON, non-objects, wrappers whose envelope will not decode — is
 * `unrecognized`.
 */
export function classifyDesktopAuthDocument(text: string): DesktopAuthClassification {
  if (text.trim() === '') return { format: 'absent' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { format: 'unrecognized' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { format: 'unrecognized' }
  const document = parsed as Record<string, unknown>
  const auth = typeof document['auth'] === 'object' && document['auth'] !== null
    ? document['auth'] as Record<string, unknown>
    : document
  const fields: WrappedAuthField[] = []
  for (const field of AUTH_FIELDS) {
    const value = auth[field]
    if (typeof value === 'string') continue
    const wrapped = parseWrappedField(field, value)
    // A field in *some* object that is not a decodable wrapper: not plaintext,
    // not usable. Treated as unrecognized below unless another field wrapped.
    if (wrapped === undefined && value !== undefined) return { format: 'unrecognized' }
    if (wrapped !== undefined) fields.push(wrapped)
  }
  if (fields.length === 0) return { format: 'plaintext' }
  return { format: 'encrypted', wrapped: { document, fields } }
}

/**
 * Decrypt a wrapped document into the plaintext text the regular parser reads.
 * Throws a diagnosable error naming the field and key ids — never envelope or
 * token content — when any wrapped field cannot be opened.
 */
export function unwrapDesktopAuthDocument(
  classification: Extract<DesktopAuthClassification, { format: 'encrypted' }>,
  openField: (wrapped: WrappedAuthField) => string,
): string {
  const wrapped = classification.wrapped
  const rebuilt = structuredClone(wrapped.document) as Record<string, unknown>
  const auth = typeof rebuilt['auth'] === 'object' && rebuilt['auth'] !== null
    ? rebuilt['auth'] as Record<string, unknown>
    : rebuilt
  for (const field of wrapped.fields) {
    auth[field.field] = openField(field)
  }
  return JSON.stringify(rebuilt)
}

/**
 * The authenticated-context AAD for one field envelope, transcribed from the
 * app bundle's `buildAuthenticatedContextAad`. Credential fields are always
 * suite 1 under the `field` framing (WBEV1); the framing family's other
 * members belong to other document kinds and are deliberately not implemented
 * — opening a field is not a place to guess at future formats.
 */
export function buildAuthenticatedContextAad(keyId: string, suite: number): Buffer {
  const prefix = Buffer.from('WB-AAD\0', 'ascii')
  const lengthPrefixed = (value: string): Buffer => {
    const bytes = Buffer.from(value, 'utf8')
    const header = Buffer.allocUnsafe(4)
    header.writeUInt32BE(bytes.length)
    return Buffer.concat([header, bytes])
  }
  const suiteBytes = Buffer.allocUnsafe(4)
  suiteBytes.writeUInt32BE(suite)
  return Buffer.concat([
    prefix, Buffer.from([1]),
    lengthPrefixed('WBEV1'),
    lengthPrefixed('sym-v1'),
    suiteBytes,
    lengthPrefixed(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ])
}

/**
 * Open one envelope with a protector key; `undefined` when it will not open.
 * The accepted format is exactly what WorkBuddy 5.6 writes — suite 1 under
 * the `field` framing — so a failure means "not this format / wrong key".
 */
export function openAuthField(key: Buffer, envelope: WorkBuddyEnvelope): string | undefined {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, envelope.nonce, { authTagLength: 16 })
    decipher.setAAD(buildAuthenticatedContextAad(envelope.keyId, envelope.suite))
    decipher.setAuthTag(envelope.authTag)
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return undefined
  }
}

/** Seal one field with the exact format `openAuthField` reads. Test helper. */
export function sealAuthFieldForTest(key: Buffer, plaintext: string, suite = 1): { '$wbEncrypted': 1, envelope: string } {
  const keyId = createHash('sha256').update(key).digest('hex').slice(0, 16)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  cipher.setAAD(buildAuthenticatedContextAad(keyId, suite))
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()])
  const inner = {
    suite,
    keyId,
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
  return { '$wbEncrypted': 1, envelope: Buffer.from(JSON.stringify(inner), 'utf8').toString('base64') }
}

/** The validated `loggerGet()` payload: the sealed at-rest secret. */
export interface WorkBuddyAtRestPayload {
  atRestSecretKey: string
}

/**
 * Validate the helper's payload against the app's own rules: `version:1` and
 * a canonical-base64 32-byte, non-all-zero secret. `undefined` otherwise.
 */
export function parseAtRestPayload(text: string): WorkBuddyAtRestPayload | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const payload = parsed as Record<string, unknown>
  if (payload['version'] !== 1) return undefined
  const secret = payload['atRestSecretKey']
  if (typeof secret !== 'string' || secret === '') return undefined
  let decoded: Buffer
  try {
    decoded = Buffer.from(secret, 'base64')
  } catch {
    return undefined
  }
  if (decoded.length !== 32) return undefined
  if (decoded.toString('base64') !== secret) return undefined
  if (decoded.every(byte => byte === 0)) return undefined
  return { atRestSecretKey: secret }
}

/** Derive the protector key from the payload's secret (sha256 over its UTF-8 string). */
export function deriveProtectorKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest()
}

/** The id envelopes name for a key: sha256(key) hex, first 16 chars. */
export function keyIdOf(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/** A resolved protector key and the id envelopes name for it. */
export interface ProtectorKey {
  key: Buffer
  keyId: string
}

/** Where the raw `loggerGet()` payload text comes from; tests stand one in. */
export type KeySource = () => Promise<string>

/** The key helper cannot be reached: no binary, spawn failure, or unusable payload. */
export class KeyUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KeyUnavailableError'
  }
}

/**
 * A key-resolution failure the card must be able to classify.
 *
 * The reason code travels with the error so the credential store can promote
 * it to `reasonCode` without re-deriving the cause from prose — a card that
 * matched on message text would break the moment the wording changed.
 *
 * It extends {@link KeyUnavailableError} rather than replacing it: the
 * check-in half catches the base class when scanning historical accounts,
 * where an unopenable backup is a skip rather than a diagnosis for the card.
 */
export class WorkBuddyElectronPathError extends KeyUnavailableError {
  readonly reasonCode: WorkBuddySignedOutReasonCode

  constructor(reasonCode: WorkBuddySignedOutReasonCode, message: string) {
    super(message)
    this.name = 'WorkBuddyElectronPathError'
    this.reasonCode = reasonCode
  }
}

/** Read the reason code off an arbitrary thrown value, when it carries one. */
export function reasonCodeOf(error: unknown): WorkBuddySignedOutReasonCode | undefined {
  return error instanceof WorkBuddyElectronPathError ? error.reasonCode : undefined
}

/** Absolute tool paths: never resolved through PATH, which a user can change. */
const MDFIND_BIN = '/usr/bin/mdfind'
const PLUTIL_BIN = '/usr/bin/plutil'
const WINDOWS_REGISTRY_ROOTS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
] as const
const WINDOWS_REGISTRY_OUTPUT_MAX_BYTES = 1024 * 1024
const WINDOWS_ELECTRON_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u
/**
 * Per-subprocess limit for one Windows registry read.
 *
 * `reg query <root> /s` over a software-dense uninstall tree takes seconds, not
 * milliseconds: the plain HKLM read alone exceedes a 3s cap on ordinary
 * developer machines, and a cut-short enumeration reports the product as
 * "could not complete" — a diagnosis that reads like "not installed" while the
 * app is sitting right there. The whole-discovery budget below is what actually
 * bounds the user's wait, so this limit only decides whether a read that would
 * have finished inside that budget is allowed to.
 *
 * Invariant (asserted by tests): never above {@link DISCOVERY_BUDGET_MS}.
 */
const DISCOVERY_STEP_TIMEOUT_MS = 10_000
/**
 * Whole-discovery budget across every root and candidate check.
 *
 * This, not the per-step limit, is the effective ceiling during a real
 * discovery: the budget's abort still fires on schedule, so raising the step
 * limit cannot make a user wait longer.
 */
const DISCOVERY_BUDGET_MS = 10_000

/** Whether every byte is ASCII, the one case where a decode cannot be wrong. */
function isAsciiOnly(bytes: Buffer): boolean {
  for (const byte of bytes) {
    if (byte >= 0x80) return false
  }
  return true
}

/** Whether a filesystem error reports an absent path. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Only known missing-key diagnostics can safely make a failed query read as empty. */
function windowsRegistryKeyMissing(stderr: string): boolean {
  const detail = stderr.trim()
  return /^ERROR:\s*The system was unable to find the specified registry key or value\.?$/iu.test(detail)
    || /^错误[:：]\s*系统找不到指定的注册表项或值[。.]?$/u.test(detail)
}

/** The real registry source: `reg.exe query <root> /s` under a per-step timeout. */
export function defaultRegistryRootQuery(env: NodeJS.ProcessEnv = process.env): RegistryRootQuery {
  const systemRoot = env.SystemRoot?.trim()
  const regPath = systemRoot === undefined || systemRoot === ''
    ? undefined
    : join(systemRoot, 'System32', 'reg.exe')
  return (root, signal) => new Promise<string>((resolve, reject) => {
    if (regPath === undefined) {
      reject(new Error('SystemRoot is not not configured, reg.exe cannot be located'))
      return
    }
    if (signal.aborted) {
      reject(new Error('discovery budget spent before reg.exe started'))
      return
    }
    let settled = false
    const child = execFile(regPath, ['query', root, '/s'], {
      maxBuffer: WINDOWS_REGISTRY_OUTPUT_MAX_BYTES,
      timeout: DISCOVERY_STEP_TIMEOUT_MS,
      windowsHide: true,
      // Raw bytes, not a decode: whether this output is ambiguous is decided
      // from the bytes themselves, so Node must not pick an encoding.
      encoding: 'buffer',
    }, (error, stdout, stderr) => {
      if (settled) return
      settled = true
      if (error !== null && error !== undefined) {
        if (error.killed !== true && (error.code === 1 || error.code === '1')
          && windowsRegistryKeyMissing(stderr.toString('utf8'))) {
          resolve('')
          return
        }
        reject(new Error(`reg.exe could not complete (${error.killed === true ? 'timed out' : String(error.code ?? 'unavailable')})`))
        return
      }
      resolve(stdout.toString('utf8'))
    })
    const abort = (): void => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error('discovery budget spent, reg.exe abandoned'))
    }
    signal.addEventListener('abort', abort, { once: true })
    child.on('close', () => { signal.removeEventListener('abort', abort) })
  })
}

/** Registry query seam so tests never spawn reg.exe. */
export type RegistryRootQuery = (root: string, signal: AbortSignal) => Promise<string>

/** Electron resolution options. */
export interface ElectronResolutionOptions {
  registry?: RegistryRootQuery
  discoveryBudgetMs?: number
  /** Which product's Electron to resolve; defaults to the CN profile. */
  product?: WorkBuddyElectronProduct
}

/**
 * The Electron binary to spawn, or a diagnosable {@link KeyUnavailableError}.
 * Order is the contract: an explicit env var is used as-is and never falls
 * back; then the platform default (Windows: the measured `%LOCALAPPDATA%`
 * layout); Windows finally falls back to uninstall-registry discovery — and
 * only after every candidate proves the Electron layout.
 */
export async function resolveElectronPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  opts: ElectronResolutionOptions = {},
): Promise<string> {
  const product = opts.product ?? CN_ELECTRON_PROFILE
  const configured = env[product.envVar]?.trim()
  if (configured !== undefined && configured !== '') {
    if (!isExecutable(configured)) {
      throw new WorkBuddyElectronPathError(
        'electron-path-invalid',
        `${product.envVar} 指定的 Electron 不可执行：${configured}`,
      )
    }
    return configured
  }
  if (platform === 'darwin') {
    if (!isExecutable(product.macOS.defaultPath)) {
      throw new WorkBuddyElectronPathError(
        'electron-binary-not-found',
        `默认路径未找到 ${product.productName} 的 Electron 二进制（App 可能装在别处）；`
        + `请用 ${product.envVar} 指定`,
      )
    }
    return product.macOS.defaultPath
  }
  if (platform !== 'win32') {
    throw new WorkBuddyElectronPathError(
      'electron-binary-unavailable',
      `此平台没有默认的 ${product.productName} Electron 路径；请用 ${product.envVar} 指定`,
    )
  }
  const localAppData = env.LOCALAPPDATA?.trim()
  const platformDefault = localAppData === undefined || localAppData === ''
    ? undefined
    : join(localAppData, ...(product.windows.defaultPathSegments ?? []))
  if (platformDefault !== undefined && product.windows.defaultPathSegments !== undefined && isExecutable(platformDefault)) {
    return platformDefault
  }
  return await discoverWindowsElectron(product, env, opts)
}

/**
 * Resolve one product's Electron through Windows uninstall records. Registry
 * entries are hints, not trust: every DisplayIcon candidate must still be the
 * product's exe with the known Electron layout before it is executed.
 */
async function discoverWindowsElectron(
  product: WorkBuddyElectronProduct,
  env: NodeJS.ProcessEnv,
  opts: ElectronResolutionOptions,
): Promise<string> {
  const registry = opts.registry ?? defaultRegistryRootQuery(env)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.discoveryBudgetMs ?? DISCOVERY_BUDGET_MS)
  try {
    const candidates: string[] = []
    let unresolved = false
    for (const root of WINDOWS_REGISTRY_ROOTS) {
      let output: string
      try {
        output = await registry(root, controller.signal)
      } catch {
        unresolved = true
        continue
      }
      const parsed = parseWindowsRegistryOutput(output, product.windows.displayNamePattern)
      candidates.push(...parsed.candidates)
      unresolved ||= parsed.incomplete
    }
    const seen = new Map<string, string>()
    const rejected: string[] = []
    for (const candidate of new Set(candidates)) {
      const inspection = inspectWindowsElectronCandidate(candidate, product.windows.exeBasename)
      if (inspection === 'unresolved') {
        unresolved = true
        continue
      }
      if (inspection === undefined) {
        rejected.push(candidate)
        continue
      }
      seen.set(inspection.identity, inspection.electronPath)
    }
    if (unresolved) {
      throw new WorkBuddyElectronPathError(
        'electron-discovery-incomplete',
        `${product.productName} 的自动定位未能完成（部分注册表项或候选无法检查）；`
        + `这不代表未安装，可用 ${product.envVar} 指定其 Electron 二进制`,
      )
    }
    if (seen.size > 1) {
      const listed = [...seen.values()].map(path => `  - ${path}`).join('\n')
      throw new WorkBuddyElectronPathError(
        'electron-binary-ambiguous',
        `找到 ${seen.size} 个 ${product.productName} 安装，无法自动选择：\n${listed}\n`
        + `请用 ${product.envVar} 指定其中一个`,
      )
    }
    if (seen.size === 1) return [...seen.values()][0]!
    throw new WorkBuddyElectronPathError(
      'electron-binary-not-found',
      rejected.length === 0
        ? `未找到 ${product.productName} 的 Electron 二进制（默认位置与 Windows 卸载记录均未命中）；`
          + `可用 ${product.envVar} 显式指定`
        : `Windows 卸载记录找到 ${rejected.length} 个 ${product.productName} 候选，但`
          + `均不符合预期的应用布局`
          + `（exe 旁应有 version 文件与 resources\\app.asar）；可用 ${product.envVar} 指定其可执行文件`,
    )
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

/**
 * Parse `reg query ... /s` value columns into DisplayIcon candidates. Entries
 * are filtered by the product's DisplayName before the icon is judged, so
 * another product's records are excluded as decisively not ours and can never
 * mark this product's search incomplete.
 */
function parseWindowsRegistryOutput(
  output: string,
  displayNamePattern: RegExp,
): { candidates: string[]; incomplete: boolean } {
  const entries = new Map<string, { displayName?: string; displayIcon?: string }>()
  let currentKey: string | undefined
  for (const line of output.split(/\r?\n/u)) {
    const keyMatch = /^\s*(HKEY_[^\r\n]+?)\s*$/iu.exec(line)
    if (keyMatch !== null) {
      currentKey = keyMatch[1]!
      entries.set(currentKey, {})
      continue
    }
    if (currentKey === undefined) continue
    const valueMatch = /^\s+(DisplayName|DisplayIcon)\s+REG_[A-Z0-9_]+\s*(.*?)\s*$/iu.exec(line)
    if (valueMatch === null) continue
    const entry = entries.get(currentKey)
    if (entry === undefined) continue
    if (valueMatch[1]!.toLowerCase() === 'displayname') entry.displayName = valueMatch[2] ?? ''
    else entry.displayIcon = valueMatch[2] ?? ''
  }
  const candidates: string[] = []
  let incomplete = false
  for (const entry of entries.values()) {
    if (entry.displayName === undefined) continue
    if (!displayNamePattern.test(entry.displayName.trim())) continue
    const displayIcon = entry.displayIcon === undefined ? undefined : parseWindowsDisplayIcon(entry.displayIcon)
    if (displayIcon === undefined) incomplete = true
    else candidates.push(displayIcon)
  }
  return { candidates, incomplete }
}

/** Read a quoted DisplayIcon path and drop the Windows icon-index suffix. */
function parseWindowsDisplayIcon(value: string): string | undefined {
  const raw = value.trim()
  let path: string
  if (raw.startsWith('"')) {
    const closingQuote = raw.indexOf('"', 1)
    if (closingQuote < 0) return undefined
    const suffix = raw.slice(closingQuote + 1).trim()
    if (suffix !== '' && !/^,\d+$/u.test(suffix)) return undefined
    path = raw.slice(1, closingQuote).replace(/,\d+$/u, '')
  } else {
    const match = /^(.+?\.exe)(?:,\d+)?$/iu.exec(raw)
    if (match === null) return undefined
    path = match[1]!
  }
  path = path.trim()
  return /\.exe$/iu.test(path) ? path : undefined
}

/** Whether a path is executable by this process. */
function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Validate the known Windows layout for one product's exe. `undefined` is a
 * decidable exclusion; `'unresolved'` is reserved for errors that prevent
 * checking.
 */
function inspectWindowsElectronCandidate(
  electronPath: string,
  exeBasename: string,
): { electronPath: string; identity: string } | 'unresolved' | undefined {
  if (basename(electronPath).toLowerCase() !== exeBasename) return undefined
  let binaryStat
  try {
    binaryStat = statSync(electronPath)
  } catch (error) {
    return isENOENT(error) ? undefined : 'unresolved'
  }
  if (!binaryStat.isFile()) return undefined
  try {
    accessSync(electronPath, constants.X_OK)
  } catch (error) {
    return isENOENT(error) ? undefined : 'unresolved'
  }
  const installRoot = dirname(electronPath)
  let version: string
  try {
    version = readFileSync(join(installRoot, 'version'), 'utf8').trim()
  } catch (error) {
    return isENOENT(error) ? undefined : 'unresolved'
  }
  if (!WINDOWS_ELECTRON_VERSION_PATTERN.test(version)) return undefined
  try {
    // The archive path must not go through fs.stat: under an Electron host
    // (DSH Desktop), asar interception stats app.asar as a directory, which
    // deterministically excluded every registry candidate. Listing the real
    // resources directory is asar-independent.
    if (!readdirSync(join(installRoot, 'resources')).includes('app.asar')) return undefined
  } catch (error) {
    return isENOENT(error) ? undefined : 'unresolved'
  }
  let identity: string
  try {
    identity = realpathSync(electronPath)
  } catch (error) {
    return isENOENT(error) ? undefined : 'unresolved'
  }
  // Windows paths are case-insensitive even when a registry entry preserved a
  // different casing.
  return { electronPath, identity: identity.toLowerCase() }
}

/**
 * Merge a `WSLENV` value so `ELECTRON_RUN_AS_NODE` crosses WSL→Windows
 * interop.
 *
 * WSL only forwards listed variables to a Windows child, and only when the
 * entry carries the `/w` (WSL→Windows) direction flag. The target variable is
 * consolidated into exactly ONE safe entry, because duplicate same-name
 * entries leave the forwarding direction indeterminate:
 *
 * - the single entry always carries `w` and takes the position of the first
 *   same-name occurrence;
 * - `u` is kept when ANY existing same-name entry asked for it;
 * - the path flags are dropped: `p` and `l` would mangle the value, which
 *   here is the numeric switch `1`;
 * - a BARE name carries no direction at all, so it counts as neither;
 * - with no same-name entry at all, `ELECTRON_RUN_AS_NODE/w` is appended;
 * - every OTHER entry keeps its order and bytes.
 *
 * The result is idempotent.
 */
export function wslenvForwardRunAsNode(value: string | undefined): string {
  const merged: string[] = []
  let targetIndex = -1
  let targetFlags = '/w'
  for (const entry of (value ?? '').split(':')) {
    if (entry === '') continue
    const slash = entry.indexOf('/')
    const name = slash === -1 ? entry : entry.slice(0, slash)
    if (name !== 'ELECTRON_RUN_AS_NODE') {
      if (!merged.includes(entry)) merged.push(entry)
      continue
    }
    const flags = slash === -1 ? '' : entry.slice(slash + 1)
    if (flags.includes('u')) targetFlags = '/uw'
    if (targetIndex === -1) {
      targetIndex = merged.length
      merged.push(`ELECTRON_RUN_AS_NODE${targetFlags}`)
    } else {
      merged[targetIndex] = `ELECTRON_RUN_AS_NODE${targetFlags}`
    }
  }
  if (targetIndex === -1) merged.push(`ELECTRON_RUN_AS_NODE${targetFlags}`)
  return merged.join(':')
}

/**
 * The environment the at-rest key helper is spawned with.
 *
 * Always a fresh object — the parent is never mutated. When the spawn crosses
 * WSL→Windows interop — a WSL host and a helper that is itself a Windows
 * executable — the child's `WSLENV` is additionally merged via
 * {@link wslenvForwardRunAsNode} so the interop layer actually forwards that
 * variable. Every other platform and path combination gets the previous
 * behaviour byte-for-byte.
 */
export function helperChildEnv(parent: NodeJS.ProcessEnv, electronPath: string, wsl: boolean): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...parent, ELECTRON_RUN_AS_NODE: '1' }
  // The interop decision follows the FILE, not the mount point: WSL's
  // automount root is configurable, so a Windows exe can legitimately live
  // outside `/mnt`. A Windows executable is recognized by its `.exe` suffix.
  if (wsl && basename(electronPath).toLowerCase().endsWith('.exe')) {
    childEnv['WSLENV'] = wslenvForwardRunAsNode(childEnv['WSLENV'])
  }
  return childEnv
}

// One line, run inside WorkBuddy's own Electron as plain Node, where the
// private workbuddyStorage binding exists. It writes nothing else, so stdout
// is the payload.
const HELPER_SCRIPT = 'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))'

/** Spawn the helper and capture its payload; every failure is diagnosable. */
function spawnPayload(electronPath: string, timeoutMs = 10_000, wsl = false): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(electronPath, ['-e', HELPER_SCRIPT], {
      timeout: timeoutMs,
      maxBuffer: 1_048_576,
      windowsHide: true,
      env: helperChildEnv(process.env, electronPath, wsl),
    }, (error, stdout) => {
      if (error !== null && error !== undefined) {
        reject(new KeyUnavailableError(
          `获取解密密钥失败（${electronPath} `
          + `${error.killed === true ? `超时 ${timeoutMs}ms` : error.code !== undefined ? `退出码 ${error.code}` : '无法启动'}）`,
        ))
        return
      }
      const output = stdout.trim()
      if (output === '') {
        reject(new KeyUnavailableError(`获取解密密钥失败（${electronPath} 无输出）`))
        return
      }      resolve(output)
    })
  })
}

/** Resolution options for {@link defaultKeySource}. */
export interface DefaultKeySourceOptions {
  /** Electron binary override; skips resolution entirely. */
  electronPath?: string
  /** Helper timeout in milliseconds. */
  timeoutMs?: number
  /** Whether the current process runs inside WSL. */
  wsl?: boolean
}

/**
 * The real source: resolve the binary on this machine (explicit env → platform
 * default → Windows registry discovery), spawn it once, take its payload.
 */
export async function defaultKeySource(options: DefaultKeySourceOptions = {}): Promise<string> {
  const electronPath = options.electronPath ?? await resolveElectronPath()
  return await spawnPayload(electronPath, options.timeoutMs, options.wsl ?? isWsl())
}

/** Whether this Linux process is running inside Windows Subsystem for Linux. */
export function isWsl(): boolean {
  if (process.platform !== 'linux') return false
  if (process.env['WSL_DISTRO_NAME'] !== undefined || process.env['WSL_INTEROP'] !== undefined) return true
  return release().toLowerCase().includes('microsoft')
}

/**
 * The machine's current protector key, resolved once per process.
 *
 * Deliberately does NOT enforce that envelope key ids match — matching each
 * envelope is the caller's job, so a backup sealed by a previous install can
 * be skipped without failing here.
 *
 * Success is cached for the default source only (one machine, one key);
 * failures are not, so a later call retries after the app appears. Custom
 * (test) sources bypass the cache entirely.
 */
let cachedDefault: ProtectorKey | undefined
let inflightDefault: Promise<ProtectorKey> | undefined

export async function protectorKey(source?: KeySource): Promise<ProtectorKey> {
  if (source === undefined) {
    if (cachedDefault !== undefined) return cachedDefault
    inflightDefault ??= (async () => {
      const payload = parseAtRestPayload(await defaultKeySource())
      if (payload === undefined) {
        throw new KeyUnavailableError('解密密钥数据不合法（应为 {version:1, atRestSecretKey}）')
      }
      const key = deriveProtectorKey(payload.atRestSecretKey)
      return { key, keyId: keyIdOf(key) }
    })().finally(() => { inflightDefault = undefined }).then(resolved => { cachedDefault = resolved; return resolved })
    return inflightDefault
  }
  const payload = parseAtRestPayload(await source())
  if (payload === undefined) {
    throw new KeyUnavailableError('解密密钥数据不合法（应为 {version:1, atRestSecretKey}）')
  }
  const key = deriveProtectorKey(payload.atRestSecretKey)
  return { key, keyId: keyIdOf(key) }
}

/** Seams the discovery flow runs through, so tests never spawn a process. */
export interface WorkBuddyDiscoveryTools {
  findApps: (signal: AbortSignal) => Promise<readonly string[]>
  bundleIdentifier: (bundlePath: string, signal: AbortSignal) => Promise<string | undefined>
  bundleVersion: (bundlePath: string, signal: AbortSignal) => Promise<string | undefined>
}

/**
 * Why a discovery step could not produce an answer. Every one of these means
 * "we do not know", explicitly *not* "the candidate does not exist" — the
 * distinction is what keeps a half-finished check from being mistaken for a
 * unique candidate.
 */
class DiscoveryIncompleteError extends Error {}

/** The default discovery tools: Spotlight for the bundle, plutil for identity. */
export function workBuddyDiscoveryTools(bundleId: string): WorkBuddyDiscoveryTools {
  const runTool = (bin: string, args: readonly string[], maxBytes: number, signal: AbortSignal): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DiscoveryIncompleteError(`${bin} was not started: the discovery budget was already spent`))
        return
      }
      let settled = false
      const child = execFile(bin, [...args], { maxBuffer: maxBytes, timeout: DISCOVERY_STEP_TIMEOUT_MS }, (error, stdout) => {
        if (settled) return
        settled = true
        if (error !== null && error !== undefined) {
          reject(new DiscoveryIncompleteError(`${bin} could not complete (${error.killed === true ? 'timed out' : String(error.code ?? 'unavailable')})`))
          return
        }
        resolve(stdout)
      })
      const abort = (): void => {
        if (settled) return
        settled = true
        child.kill()
        reject(new DiscoveryIncompleteError(`${bin} was abandoned: the discovery budget was spent`))
      }
      signal.addEventListener('abort', abort, { once: true })
      child.on('close', () => { signal.removeEventListener('abort', abort) })
    })

  return {
    findApps: async signal => {
      const out = await runTool(MDFIND_BIN, [`kMDItemCFBundleIdentifier == '${bundleId}'`], 1024 * 1024, signal)
      return out.split('\n').map(line => line.trim()).filter(line => line.endsWith('.app'))
    },
    bundleIdentifier: async (bundlePath, signal) => {
      try {
        const out = await runTool(PLUTIL_BIN, ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(bundlePath, 'Contents', 'Info.plist')], 64 * 1024, signal)
        return out.trim()
      } catch {
        // An unreadable plist is "we could not check this one", not "this one
        // does not match" — the candidate stays unresolved.
        return undefined
      }
    },
    bundleVersion: async (bundlePath, signal) => {
      try {
        const out = await runTool(PLUTIL_BIN, ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(bundlePath, 'Contents', 'Info.plist')], 64 * 1024, signal)
        const version = out.trim()
        return version === '' ? undefined : version
      } catch {
        return undefined
      }
    },
  }
}

/**
 * Which automatic discovery, if any, a provider may run when no explicit
 * binary is configured. The value says which *platform* may be searched,
 * never which product: two products on the same platform are told apart by
 * the product profile.
 */
export type WorkBuddyElectronDiscovery = 'none' | 'macos-workbuddy' | 'windows-workbuddy'

/** Select discovery by platform. */
export function electronDiscoveryFor(platform: NodeJS.Platform = process.platform): WorkBuddyElectronDiscovery {
  if (platform === 'darwin') return 'macos-workbuddy'
  if (platform === 'win32') return 'windows-workbuddy'
  return 'none'
}

/** Provider options. */
export interface WorkBuddyAtRestKeyProviderOptions {
  /** Which product's Electron this provider resolves. */
  product: WorkBuddyElectronProduct
  /** Explicit Electron binary; overrides the platform default and env. */
  electronPath?: string
  /** Helper timeout in milliseconds; default 10s. */
  timeoutMs?: number
  /** Where the payload comes from; defaults to spawning the app's Electron. */
  source?: KeySource
  /** Runs the helper at the resolved path, keeping resolution real. */
  spawnHelper?: (electronPath: string) => Promise<string>
  /** Automatic discovery budget; defaults to `'none'`. */
  discovery?: WorkBuddyElectronDiscovery
  /** Platform default binary, consulted only when discovery is enabled. */
  defaultElectronPath?: string | undefined
  /** Discovery subprocesses; injectable so tests never spawn. */
  tools?: WorkBuddyDiscoveryTools
  /** Platform override for deterministic discovery tests. */
  platform?: NodeJS.Platform
  /** Whether the helper spawn crosses WSL→Windows interop. */
  wsl?: () => boolean
  /** Total budget for one discovery run. */
  discoveryBudgetMs?: number
}

/** The at-rest key provider one product's store should use. */
export class WorkBuddyAtRestKeyProvider {
  private readonly explicitPath: string | undefined
  private readonly product: WorkBuddyElectronProduct
  private readonly defaultPath: string | undefined
  private readonly discovery: WorkBuddyElectronDiscovery
  private readonly tools: WorkBuddyDiscoveryTools
  private readonly platform: NodeJS.Platform
  private readonly discoveryBudgetMs: number
  private readonly timeoutMs: number
  private readonly wsl: () => boolean
  private readonly source: KeySource
  private readonly spawnHelper: (electronPath: string) => Promise<string>
  /** Cached only on success; a failure leaves this unset so discovery retries. */
  private discoveredPath: string | undefined
  private cache: ProtectorKey | undefined
  private inflight: Promise<ProtectorKey> | undefined

  constructor(options: WorkBuddyAtRestKeyProviderOptions) {
    this.product = options.product
    const fromEnv = process.env[options.product.envVar]?.trim()
    const envPath = fromEnv === undefined || fromEnv === '' ? undefined : fromEnv
    // Explicit sources are authoritative and mutually exclusive with
    // discovery: naming a binary means "use this one", so an unusable one is
    // an error, not an invitation to go looking for another app.
    this.explicitPath = options.electronPath ?? envPath
    this.discovery = options.discovery ?? 'none'
    this.platform = options.platform ?? process.platform
    this.defaultPath = this.discovery === 'none'
      ? undefined
      : options.defaultElectronPath === undefined
        ? defaultWorkBuddyElectronPath(options.product, this.platform)
        : options.defaultElectronPath ?? undefined
    this.tools = options.tools ?? workBuddyDiscoveryTools(options.product.macOS.bundleId)
    this.discoveryBudgetMs = options.discoveryBudgetMs ?? DISCOVERY_BUDGET_MS
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.wsl = options.wsl ?? isWsl
    this.spawnHelper = options.spawnHelper ?? (path => this.spawnAt(path))
    this.source = options.source ?? (() => this.spawnPayload())
  }

  /**
   * The binary the default helper would use, for diagnostics. Reports a
   * *discovery result* once one exists; this accessor never triggers a
   * search.
   */
  helperPath(): string | undefined {
    if (this.explicitPath !== undefined) return this.explicitPath
    if (this.discovery === 'none') return undefined
    return this.discoveredPath ?? this.defaultPath
  }

  /**
   * A protector key matching one of the requested envelope key ids. The first
   * id the cache answers wins; otherwise one spawn resolves the current key,
   * which must match a request — a mismatch means the envelopes were sealed
   * by a different install than the one this machine now runs.
   */
  async protectorKeyFor(requested: readonly string[]): Promise<Buffer> {
    if (requested.length === 0) {
      throw new KeyUnavailableError('加密的桌面凭据未携带任何密钥 id')
    }
    const cached = this.cache
    if (cached !== undefined && requested.includes(cached.keyId)) return cached.key
    this.inflight ??= this.source().then(text => this.ingest(text))
      .finally(() => {
        this.inflight = undefined
      })
    const resolved = await this.inflight
    if (!requested.includes(resolved.keyId)) {
      throw new WorkBuddyElectronPathError(
        'encrypted-credential-unreadable',
        `WorkBuddy's current at-rest key (id ${resolved.keyId}) does not match the credential's envelope`
        + ` (id ${requested.join(' or ')}); the file was sealed by a different install — open the`
        + ` ${this.product.productName} app once to reseal the sign-in`,
      )
    }
    return resolved.key
  }

  /** Ingest one helper payload into a validated key. */
  private async ingest(text: string): Promise<ProtectorKey> {
    const payload = parseAtRestPayload(text)
    if (payload === undefined) {
      throw new WorkBuddyElectronPathError(
        'encrypted-credential-unreadable',
        '解密密钥数据不合法（应为 {version:1, atRestSecretKey}）',
      )
    }
    const key = deriveProtectorKey(payload.atRestSecretKey)
    return { key, keyId: keyIdOf(key) }
  }

  /** Resolve the binary, then run the helper there. */
  private async spawnPayload(): Promise<string> {
    const electronPath = await this.resolveElectronPath()
    return await this.spawnHelper(electronPath)
  }

  /** Run the helper at an already-resolved path. */
  private async spawnAt(electronPath: string): Promise<string> {
    return await spawnPayload(electronPath, this.timeoutMs, this.wsl())
  }

  /**
   * The explicit path, the platform default, or discovery — in that order.
   *
   * The platform default is only a *default*, not a commitment: a machine that
   * installed the app somewhere else has no file there, and returning that
   * absent path would make the caller fail with `ENOENT` instead of falling
   * through to registry discovery. The default therefore has to prove it
   * exists before it is returned — that ordering is what makes a custom
   * install location work at all.
   */
  private async resolveElectronPath(): Promise<string> {
    if (this.explicitPath !== undefined) {
      // An explicit path is authoritative and never falls back: naming a
      // binary means "use this one", so an unusable one is an error.
      return this.explicitPath
    }
    if (this.discovery === 'none') {
      throw new WorkBuddyElectronPathError(
        'electron-binary-unavailable',
        `此平台未配置 ${this.product.productName} 的 Electron 路径`
        + `，也没有可用的自动发现；请用 ${this.product.envVar} 指定其二进制`,
      )
    }
    if (this.defaultPath !== undefined && isExecutable(this.defaultPath)) {
      return this.defaultPath
    }
    // The default location is empty, so the app lives somewhere else. Windows
    // resolves it through uninstall records, which is the only discovery this
    // bundle implements.
    if (this.discovery !== 'windows-workbuddy') {
      throw new WorkBuddyElectronPathError(
        'electron-binary-not-found',
        `默认位置未找到 ${this.product.productName} 的 Electron 二进制，`
        + `且此平台没有可用的自动发现；请用 ${this.product.envVar} 显式指定`,
      )
    }
    const discovered = await discoverWindowsElectron(
      this.product,
      process.env,
      { discoveryBudgetMs: this.discoveryBudgetMs },
    )
    this.discoveredPath = discovered
    return discovered
  }
}

/**
 * The at-rest key provider one variant's store should use. Shared by the
 * plugin host and the CLI entry so the browser card and `doctor`/`status` can
 * never disagree about which binary a variant resolves.
 */
export function atRestKeyProviderFor(
  variant: Pick<WorkBuddyVariant, 'id' | 'electron'> | undefined,
): WorkBuddyAtRestKeyProvider {
  return new WorkBuddyAtRestKeyProvider({
    product: electronProfileFor(variant),
    discovery: electronDiscoveryFor(),
  })
}
