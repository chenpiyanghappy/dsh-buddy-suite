/**
 * WorkBuddy CN daily check-in: discover every account that ever signed in on
 * this machine, claim each one's daily credit, and report the outcome.
 *
 * The upstream is the desktop client's own endpoint, not an open API: the
 * check-in answers an international token with 401, so this half is CN-only by
 * measurement and the international auth file is excluded by filename.
 *
 * Design constraints that shape the module:
 *
 * - **No timers.** A check-in happens at DSH startup and on panel interaction.
 *   The upstream only signs *today*, so a missed day cannot be recovered and a
 *   cron would only burn requests on a day nobody opened DSH.
 * - **Idempotent.** `run()` never re-requests an account already signed or
 *   already credited today, so restarts and panel opens are free.
 * - **Never repeat a successful manual sign-in.** An account the user already
 *   signed in the App reads as `already`, which is what keeps the plugin from
 *   re-posting on their behalf.
 * - **A failed account is retried, not dropped.** The panel retries exactly
 *   today's failures; a credential that became unreadable later never demotes
 *   an account that already succeeded.
 *
 * Credential discovery reads the shared `CodeBuddyExtension` auth directory,
 * where the app leaves a timestamped backup per sign-in and account switch.
 * Each uid keeps its newest *usable* file: a plaintext one is always usable,
 * and an encrypted one is usable when this machine's current at-rest key
 * opens it. A uid whose files cannot be opened is reported rather than
 * silently dropped — "we could not read this account" is a different message
 * from "there is no such account".
 *
 * @module dsh-buddy-suite/checkin
 */

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { homedir, release } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  keyIdOf,
  KeyUnavailableError,
  openAuthField,
  parseAtRestPayload,
  parseWrappedField,
  deriveProtectorKey,
  type KeySource,
  type WorkBuddyEnvelope,
} from './desktop-credential-protection.ts'
import { BUDDY_CHECKIN_FILENAME } from './state-paths.ts'
import type { BuddyCheckinDocument, BuddyCheckinRow } from './status-paths.ts'

/** One account's check-in outcome. */
export interface BuddyCheckinResult {
  uid: string
  nickname?: string
  state: 'signed' | 'already' | 'failed'
  /** ISO timestamp. */
  at: string
  /** Credit granted by this check-in. */
  credit?: number
  /** Latest remaining credit, from a balance read. */
  balance?: number
  /** ISO timestamp of the last balance read. */
  balanceCheckedAt?: string
  /** Why the balance could not be read. */
  balanceError?: string
  /** Why the check-in failed. */
  error?: string
}

/** The persisted check-in state for one day. */
export interface BuddyCheckinSaved {
  /** Calendar day in `YYYY-MM-DD`, Asia/Shanghai. */
  day: string
  /** ISO timestamp of the attempt that produced this state. */
  checkedAt: string
  /** ISO timestamp of the last balance refresh. */
  balanceCheckedAt?: string
  /** One-shot startup summary, claimed by its first reader. */
  notice?: string
  results: BuddyCheckinResult[]
}

/** An account visible in the auth directory whose credential could not be read. */
export interface BuddyCheckinUnreadable {
  uid: string
  reason: string
}

/** Everything discovery found: usable credentials and the accounts it could not read. */
export interface BuddyCheckinDiscovery {
  credentials: BuddyCheckinCredential[]
  unreadable: BuddyCheckinUnreadable[]
}

/** A discovered account credential. */
export interface BuddyCheckinCredential {
  uid: string
  nickname?: string
  accessToken: string
  /** Login domain, e.g. `www.codebuddy.cn`. */
  domain: string
  enterpriseId?: string
}

/** Discovery options. */
export interface BuddyCheckinDiscoveryOptions {
  /** Where the at-rest key payload comes from; tests stand one in. */
  keySource?: KeySource
}

/** Run options. */
export interface BuddyCheckinRunOptions extends BuddyCheckinDiscoveryOptions {
  /** Whether a failed run may queue a startup notice; `false` suppresses it. */
  notice?: boolean
}

/** Auth-file basenames that belong to the CN product; the AI file is excluded. */
const CN_AUTH_FILE = 'workbuddy-desktop.info'

/** Backup basenames the app leaves per sign-in, e.g. `workbuddy-desktop.2026-10-17.info`. */
const CN_AUTH_BACKUP = /^workbuddy-desktop\.\d{4}-/u

/** The calendar day the check-in belongs to, in the app's own zone. */
const DAY_ZONE = 'Asia/Shanghai'

/** Balance-read timeout, milliseconds. */
const BALANCE_TIMEOUT_MS = 15_000

/**
 * Whether this Linux process is running inside Windows Subsystem for Linux.
 */
function isWsl(): boolean {
  if (process.platform !== 'linux') return false
  if (process.env['WSL_DISTRO_NAME'] !== undefined || process.env['WSL_INTEROP'] !== undefined) return true
  return release().toLowerCase().includes('microsoft')
}

/** Convert a Windows drive path to WSL's conventional `/mnt/<drive>` form. */
function windowsPathForWsl(value: string | undefined): string | undefined {
  const path = value?.trim()
  if (path === undefined || path === '') return undefined
  if (path.startsWith('/')) return path
  const drive = /^([a-z]):[\\/](.*)$/iu.exec(path)
  return drive === null ? undefined : join('/mnt', drive[1]!.toLowerCase(), ...drive[2]!.split(/[\\/]+/u))
}

/** Windows auth dirs seen from a WSL process, through its mounted Windows profile. */
function wslWindowsBases(): string[] {
  const profile = windowsPathForWsl(process.env['USERPROFILE']) ?? join('/mnt/c/Users', basename(homedir()))
  const local = windowsPathForWsl(process.env['LOCALAPPDATA']) ?? join(profile, 'AppData', 'Local')
  const roaming = windowsPathForWsl(process.env['APPDATA']) ?? join(profile, 'AppData', 'Roaming')
  return [local, roaming]
}

/** The XDG base for one env variable, or its platform default. */
function xdgBase(name: string, fallback: string): string {
  const value = process.env[name]?.trim()
  return value !== undefined && value !== '' && value.startsWith('/') ? value : fallback
}

/**
 * Windows prefers Local, with Roaming for older desktop versions. Linux probes
 * both XDG bases — most distributions write under the config home, but
 * UOS/deepin builds under the data home, and probing only one silently reads a
 * signed-in app as signed out. Under WSL the Windows-side auth dirs are probed
 * first through the mounted profile: the desktop app there is the Windows one,
 * whose credentials live on the Windows disk.
 */
export function authDirsFor(): string[] {
  const bases = process.platform === 'win32'
    ? [process.env['LOCALAPPDATA'] || join(homedir(), 'AppData', 'Local'), process.env['APPDATA'] || join(homedir(), 'AppData', 'Roaming')]
    : process.platform === 'darwin'
      ? [join(homedir(), 'Library', 'Application Support')]
      : isWsl()
        ? [...wslWindowsBases(), xdgBase('XDG_CONFIG_HOME', join(homedir(), '.config')), xdgBase('XDG_DATA_HOME', join(homedir(), '.local', 'share'))]
        : [xdgBase('XDG_CONFIG_HOME', join(homedir(), '.config')), xdgBase('XDG_DATA_HOME', join(homedir(), '.local', 'share'))]
  return [...new Set(bases.map(base => join(base, 'CodeBuddyExtension', 'Data', 'Public', 'auth')))]
}

/** The first auth dir, for diagnostics. */
export const authDirFor = (): string => authDirsFor()[0]!

/** Today's calendar day in the app's zone. */
export function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: DAY_ZONE }).format(new Date())
}

/** Optional non-empty string, or undefined. */
function string(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * One backup file reduced to what discovery needs. `uid` and `domain` stay
 * plaintext in WorkBuddy 5.6's encrypted files; only the token (and nickname)
 * are sealed, so an encrypted backup is still attributable to its account.
 * `token`/`tokenEnvelope` are mutually exclusive; neither being set means the
 * token field is present but is neither a string nor a decodable envelope.
 */
interface BuddyCandidate {
  name: string
  uid: string
  domain: string
  nickname?: string
  token?: string
  tokenEnvelope?: WorkBuddyEnvelope
  nicknameEnvelope?: WorkBuddyEnvelope
}

/** Reduce one raw backup document to a candidate, or undefined when unusable. */
function candidate(name: string, raw: unknown): BuddyCandidate | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const document = raw as Record<string, unknown>
  const account = document['account'] as Record<string, unknown> | undefined
  const auth = document['auth'] as Record<string, unknown> | undefined
  const uid = string(account?.['uid'])
  const domain = string(auth?.['domain']) ?? string((account?.['domain'] as Record<string, unknown> | undefined)?.['domain'])
  if (uid === undefined || domain === undefined) return undefined
  const token = string(auth?.['accessToken'])
  const tokenEnvelope = token === undefined ? parseWrappedField('accessToken', auth?.['accessToken'])?.envelope : undefined
  const nickname = string(account?.['nickname'])
  const nicknameEnvelope = nickname === undefined ? parseWrappedField('accessToken', account?.['nickname'])?.envelope : undefined
  return {
    name,
    uid,
    domain,
    ...token === undefined ? {} : { token },
    ...tokenEnvelope === undefined ? {} : { tokenEnvelope },
    ...nickname === undefined ? {} : { nickname },
    ...nicknameEnvelope === undefined ? {} : { nicknameEnvelope },
  }
}

/**
 * Best credential for one uid: newest file first, skipping encrypted backups
 * this machine's key cannot open.
 *
 * A plaintext file always wins over an older encrypted one, because the
 * newest file is the one the app itself would load. An encrypted file whose
 * key id matches the machine's current key is opened; one sealed by a
 * different install is skipped so an older plaintext file still has its turn.
 */
function resolveUid(
  files: readonly BuddyCandidate[],
  key: { key: Buffer; keyId: string } | undefined,
  keyError: string | undefined,
): { credential?: BuddyCheckinCredential; reason?: string } {
  for (const file of files) {
    if (file.token !== undefined) {
      return {
        credential: {
          uid: file.uid,
          domain: file.domain,
          accessToken: file.token,
          ...file.nickname === undefined ? {} : { nickname: file.nickname },
        },
      }
    }
    if (file.tokenEnvelope !== undefined && key !== undefined && key.keyId === file.tokenEnvelope.keyId) {
      const token = openAuthField(key.key, file.tokenEnvelope)
      if (token === undefined) continue
      const nickname = file.nicknameEnvelope === undefined ? undefined : openAuthField(key.key, file.nicknameEnvelope)
      return {
        credential: {
          uid: file.uid,
          domain: file.domain,
          accessToken: token,
          ...nickname === undefined || nickname === '' ? {} : { nickname },
        },
      }
    }
  }
  const encrypted = files.some(file => file.tokenEnvelope !== undefined)
  const reason = encrypted && keyError !== undefined
    ? `credential is encrypted and ${keyError}`
    : encrypted
      ? 'the credential is sealed under a key this WorkBuddy install cannot open (likely a backup from before the app was reinstalled); sign in to this account once in the WorkBuddy app to restore it'
      : 'the credential file is not in a recognized format; sign in to this account once in the WorkBuddy app to restore it'
  return { reason }
}

/**
 * Discover every account that ever signed in on this machine, each uid with
 * its newest *usable* credential.
 *
 * One key resolution per directory at most, and only when an encrypted
 * candidate exists — the plaintext path must never spawn the app's Electron.
 */
export async function discover(
  dirs: string | readonly string[] = authDirsFor(),
  opts: BuddyCheckinDiscoveryOptions = {},
): Promise<BuddyCheckinDiscovery> {
  let accumulated: BuddyCheckinUnreadable[] = []
  for (const dir of typeof dirs === 'string' ? [dirs] : dirs) {
    const files = await readdir(dir).catch(() => [] as string[])
    const groups = new Map<string, BuddyCandidate[]>()
    for (const name of files) {
      if (name !== CN_AUTH_FILE && !CN_AUTH_BACKUP.test(name)) continue
      let raw: unknown = null
      try {
        raw = JSON.parse(await readFile(join(dir, name), 'utf8'))
      } catch {
        // An unparsable backup is not attributable to any account, so it is
        // skipped rather than reported: naming a uid we cannot read would be
        // a guess, and the app's own newest file still answers for it.
      }
      const found = candidate(name, raw)
      if (found === undefined) continue
      const list = groups.get(found.uid) ?? []
      list.push(found)
      groups.set(found.uid, list)
    }
    if (groups.size === 0) continue
    // Newest per uid first; the live file sorts above any timestamped backup,
    // matching the app's own load order.
    for (const list of groups.values()) {
      list.sort((x, y) => (y.name < x.name ? -1 : y.name > x.name ? 1 : 0))
    }
    let key: { key: Buffer; keyId: string } | undefined
    let keyError: string | undefined
    if ([...groups.values()].some(list => list.some(entry => entry.tokenEnvelope !== undefined))) {
      try {
        key = await resolveKey(opts.keySource)
      } catch (error: unknown) {
        keyError = error instanceof Error ? error.message : String(error)
      }
    }
    const credentials: BuddyCheckinCredential[] = []
    const unreadable: BuddyCheckinUnreadable[] = []
    for (const [uid, list] of groups) {
      const resolved = resolveUid(list, key, keyError)
      if (resolved.credential !== undefined) credentials.push(resolved.credential)
      else unreadable.push({ uid, reason: resolved.reason ?? 'the credential could not be read' })
    }
    if (credentials.length > 0) {
      // A later directory's plaintext may rescue a uid an earlier one could not
      // open; never let an account vanish.
      const rescued = new Set(credentials.map(entry => entry.uid))
      return { credentials, unreadable: [...accumulated, ...unreadable].filter(entry => !rescued.has(entry.uid)) }
    }
    accumulated = [...accumulated, ...unreadable]
  }
  return { credentials: [], unreadable: accumulated }
}

/** Resolve the machine's current at-rest key, honouring an injected source. */
async function resolveKey(source?: KeySource): Promise<{ key: Buffer; keyId: string }> {
  if (source !== undefined) {
    const payload = parseAtRestPayload(await source())
    if (payload === undefined) throw new KeyUnavailableError('the decryption key payload is not valid')
    const key = deriveProtectorKey(payload.atRestSecretKey)
    return { key, keyId: keyIdOf(key) }
  }
  // The default source spawns the app's own Electron; imported lazily so a
  // plaintext-only machine never loads the resolver's dependencies.
  const { protectorKey } = await import('./desktop-credential-protection.ts')
  return await protectorKey()
}

/** Headers every upstream request shares. */
function headers(credential: BuddyCheckinCredential): Record<string, string> {
  return {
    'content-type': 'application/json',
    'authorization': `Bearer ${credential.accessToken}`,
    'x-user-id': credential.uid,
    'x-domain': credential.domain,
    ...credential.enterpriseId !== undefined && credential.enterpriseId !== ''
      ? { 'x-enterprise-id': credential.enterpriseId, 'x-tenant-id': credential.enterpriseId }
      : {},
  }
}

/**
 * The account's remaining credit, or undefined when the answer cannot be read.
 *
 * The response is deeply nested and the upstream is free to omit any level, so
 * each hop is guarded: a missing level reads as "unknown", never as zero —
 * rendering 0 for an answer we did not understand is how a balance bug stays
 * invisible.
 */
async function balance(credential: BuddyCheckinCredential): Promise<number | undefined> {
  const response = await fetch(`https://${credential.domain}/v2/billing/meter/get-user-resource`, {
    method: 'POST',
    headers: headers(credential),
    signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
    body: JSON.stringify({
      PageNumber: 1,
      PageSize: 100,
      ProductCode: 'p_tcaca',
      Status: [0, 3],
      PackageEndTimeRangeBegin: formatLocal(new Date()),
      PackageEndTimeRangeEnd: formatLocal(new Date(Date.now() + 365 * 101 * 24 * 3600 * 1000)),
    }),
  })
  const body = await response.json() as Record<string, unknown>
  if (!response.ok || (body['code'] !== undefined && body['code'] !== 0)) return undefined
  const data = body['data'] as Record<string, unknown> | undefined
  const inner = data?.['Response'] as Record<string, unknown> | undefined
  const accounts = inner?.['Data'] as Record<string, unknown> | undefined
  const list = accounts?.['Accounts']
  if (!Array.isArray(list)) return undefined
  let total = 0
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue
    const account = entry as Record<string, unknown>
    const remain = account['CycleCapacityRemain']
    if (typeof remain === 'number') total += remain
  }
  return total
}

/** Format a date as the billing endpoint's zone-less local spelling. */
function formatLocal(date: Date): string {
  const pad = (value: number, width = 2): string => value.toString().padStart(width, '0')
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * Claim today's credit for one account.
 *
 * The upstream answers an already-claimed account with a message containing
 * 「已签到」 and a non-2xx status, which is why the check for it comes before
 * the status check rather than after: treating that as a failure would make
 * every restart look like a broken plugin.
 */
export async function check(credential: BuddyCheckinCredential): Promise<BuddyCheckinResult> {
  const at = new Date().toISOString()
  try {
    const response = await fetch(`https://${credential.domain}/v2/billing/meter/daily-checkin`, {
      method: 'POST',
      headers: headers(credential),
      body: '{}',
    })
    const body = await response.json() as Record<string, unknown>
    const already = string(body['msg'])?.includes('已签到') === true
    if (!response.ok && !already) throw new Error(string(body['msg']) ?? `HTTP ${response.status}`)
    const total = await balance(credential).catch(() => undefined)
    const data = body['data'] as Record<string, unknown> | undefined
    const credit = typeof data?.['credit'] === 'number' ? data['credit'] as number : undefined
    return {
      uid: credential.uid,
      ...credential.nickname === undefined ? {} : { nickname: credential.nickname },
      state: already ? 'already' : 'signed',
      at,
      ...!already && credit !== undefined ? { credit } : {},
      ...total === undefined ? {} : { balance: total },
      ...total === undefined ? {} : { balanceCheckedAt: at },
    }
  } catch (error: unknown) {
    return {
      uid: credential.uid,
      ...credential.nickname === undefined ? {} : { nickname: credential.nickname },
      state: 'failed',
      at,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** The state file's path, honouring `$DSH_HOME`. */
export function statePath(): string {
  return join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), BUDDY_CHECKIN_FILENAME)
}

/** Pre-rename state file, read as a fallback so an upgrade keeps today's results. */
function legacyStatePath(path: string): string | undefined {
  return path.endsWith(BUDDY_CHECKIN_FILENAME)
    ? path.replace(new RegExp(`${BUDDY_CHECKIN_FILENAME.replace('.', '\\.')}$`, 'u'), '.workbuddy-checkin.json')
    : undefined
}

/** Parse a persisted document, rejecting every other shape. */
function savedDocument(parsed: unknown): BuddyCheckinSaved | undefined {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  if (typeof document['day'] !== 'string' || typeof document['checkedAt'] !== 'string' || !Array.isArray(document['results'])) {
    return undefined
  }
  return document as unknown as BuddyCheckinSaved
}

/** Read the persisted state, falling back to the pre-rename filename. */
export async function load(path: string = statePath()): Promise<BuddyCheckinSaved | undefined> {
  try {
    return savedDocument(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    // Fall through to the legacy name below.
  }
  const legacy = legacyStatePath(path)
  if (legacy === undefined) return undefined
  try {
    return savedDocument(JSON.parse(await readFile(legacy, 'utf8')))
  } catch {
    return undefined
  }
}

/** Write the state atomically, so a crash never leaves a half-written file. */
async function save(saved: BuddyCheckinSaved, path: string = statePath()): Promise<BuddyCheckinSaved> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, JSON.stringify(saved), { mode: 0o600 })
  await rename(temporary, path)
  return saved
}

/**
 * Roll-up status for one saved document.
 *
 * `none` means "no account at all", which is the only state that hides the
 * panel entry: a machine with no WorkBuddy CN sign-in has nothing to report.
 */
export function status(saved: BuddyCheckinSaved): BuddyCheckinDocument['status'] {
  if (saved.results.length === 0) return 'none'
  if (saved.results.every(row => row.state !== 'failed')) return 'ok'
  return saved.results.some(row => row.state !== 'failed') ? 'warn' : 'error'
}

/** Parse a persisted ISO timestamp, or 0 when it is absent or malformed. */
function epochOf(value: string | undefined): number {
  if (value === undefined) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Convert one persisted row into the wire shape the panel renders. */
function rowOf(row: BuddyCheckinResult): BuddyCheckinRow {
  return {
    uid: row.uid,
    ...row.nickname === undefined ? {} : { nickname: row.nickname },
    state: row.state,
    // Epoch milliseconds, so the browser half never parses a date string it
    // did not produce.
    at: epochOf(row.at),
    ...row.credit === undefined ? {} : { credit: row.credit },
    ...row.balance === undefined ? {} : { balance: row.balance },
    ...row.balanceCheckedAt === undefined ? {} : { balanceCheckedAt: epochOf(row.balanceCheckedAt) },
    ...row.balanceError === undefined ? {} : { balanceError: row.balanceError },
    ...row.error === undefined ? {} : { error: row.error },
  }
}

/**
 * The document a status response carries: the saved state plus its roll-up.
 *
 * Timestamps are converted to epoch milliseconds here rather than in the
 * browser, so the panel never has to parse a date string it did not produce —
 * and a malformed one reads as 0 ("unknown") instead of `Invalid Date`.
 */
export function documentOf(saved: BuddyCheckinSaved | undefined): BuddyCheckinDocument {
  if (saved === undefined) {
    return { day: today(), checkedAt: 0, results: [], status: 'none' }
  }
  return {
    day: saved.day,
    checkedAt: epochOf(saved.checkedAt),
    ...saved.balanceCheckedAt === undefined ? {} : { balanceCheckedAt: epochOf(saved.balanceCheckedAt) },
    ...saved.notice === undefined ? {} : { notice: saved.notice },
    results: saved.results.map(rowOf),
    status: status(saved),
  }
}

/**
 * Run today's check-in for every account that still owes one.
 *
 * Accounts already signed or already credited today are carried over
 * untouched, so a restart is free. Accounts that could not be read are
 * reported as failures rather than skipped, which is what makes "sign in
 * again in the app" reachable from the panel.
 */
export async function run(path: string = statePath(), opts: BuddyCheckinRunOptions = {}): Promise<BuddyCheckinSaved> {
  const previous = await load(path)
  const day = today()
  const sameDay = previous?.day === day
  const prior = sameDay ? previous!.results : []
  const completed = new Map(prior.filter(row => row.state !== 'failed').map(row => [row.uid, row]))
  const { credentials, unreadable } = await discover(authDirsFor(), opts)
  const attempted = await Promise.all(
    credentials.filter(credential => !completed.has(credential.uid)).map(credential => check(credential)),
  )
  const blocked = unreadable
    .filter(entry => !completed.has(entry.uid))
    .map<BuddyCheckinResult>(entry => ({
      uid: entry.uid,
      state: 'failed',
      at: new Date().toISOString(),
      error: entry.reason,
    }))
  const tried = [...attempted, ...blocked]
  const results = credentials
    .map(credential => completed.get(credential.uid))
    .filter((row): row is BuddyCheckinResult => row !== undefined)
    .concat(tried)
  const ok = tried.filter(row => row.state !== 'failed').length
  // The panel-open rollover shows its outcome in the panel itself, so it skips
  // the notice: a notice would toast some later page load out of nowhere.
  const notice = opts.notice === false || tried.length === 0
    ? undefined
    : tried.some(row => row.state === 'failed')
      ? `WorkBuddy check-in: ${ok}/${tried.length} accounts succeeded; the failed ones can be retried in the panel`
      : `WorkBuddy daily check-in complete: ${ok} account(s)`
  return await save({
    day,
    checkedAt: new Date().toISOString(),
    results,
    ...sameDay && previous?.balanceCheckedAt !== undefined ? { balanceCheckedAt: previous.balanceCheckedAt } : {},
    ...notice === undefined ? {} : { notice },
  }, path)
}

/**
 * Interactive day-rollover guard for a long-lived DSH process: state stored for
 * an earlier day triggers a fresh full attempt. `run()` never re-requests rows
 * already signed or already credited today, so this is safe on every open.
 */
export async function ensureToday(path: string = statePath(), opts: BuddyCheckinRunOptions = {}): Promise<BuddyCheckinSaved | undefined> {
  const saved = await load(path)
  return saved?.day === today() ? saved : await run(path, opts)
}

/**
 * Refresh balances without repeating the daily check-in.
 *
 * Balance observations are response-only: the freshly read balances are
 * merged into whatever the state file holds *now*, so a concurrent check-in
 * write is never overwritten by a slower balance read.
 */
export async function refreshBalances(
  path: string = statePath(),
  accounts?: readonly BuddyCheckinCredential[],
  opts: BuddyCheckinDiscoveryOptions = {},
): Promise<BuddyCheckinSaved | undefined> {
  const previous = await load(path)
  if (previous === undefined) return undefined
  let discovered: readonly BuddyCheckinCredential[]
  let unreadableByUid = new Map<string, string>()
  if (accounts === undefined) {
    const found = await discover(authDirsFor(), opts)
    discovered = found.credentials
    unreadableByUid = new Map(found.unreadable.map(entry => [entry.uid, entry.reason]))
  } else {
    discovered = accounts
  }
  const accountByUid = new Map(discovered.map(account => [account.uid, account]))
  const results = await Promise.all(previous.results.map(async row => {
    const account = accountByUid.get(row.uid)
    if (account === undefined) {
      return { ...row, balanceError: unreadableByUid.get(row.uid) ?? 'no credential found; showing the last record' }
    }
    const total = await balance(account).catch(() => undefined)
    return total === undefined
      ? { ...row, balanceError: 'balance read failed; showing the last record' }
      : { ...row, balance: total, balanceCheckedAt: new Date().toISOString() }
  }))
  const latest = await load(path)
  if (latest === undefined || latest.day !== previous.day) return latest
  const observations = new Map(results.map(row => [row.uid, row]))
  return {
    ...latest,
    results: latest.results.map(row => {
      const observed = observations.get(row.uid)
      if (observed === undefined) return row
      return {
        ...row,
        ...observed.balance === undefined ? {} : { balance: observed.balance },
        ...observed.balanceCheckedAt !== undefined ? { balanceCheckedAt: observed.balanceCheckedAt } : {},
        ...observed.balanceError !== undefined ? { balanceError: observed.balanceError } : {},
      }
    }),
  }
}

/**
 * Hand a persisted notice to its first reader only: that read also strips the
 * notice from the state file, so a remount or a second window no longer
 * re-toasts it. Only the notice is removed — re-reading before the write keeps
 * any concurrent check-in/retry results.
 *
 * Ordering is what makes the hand-over exactly once:
 *
 * 1. the first reader gets the row *with* its notice;
 * 2. the notice is then stripped from disk;
 * 3. a later reader finds no notice and gets the row as it stands.
 *
 * A reader that loses the race — another one claimed between this call's two
 * reads — gets the already-stripped row, so two windows cannot both toast.
 */
export async function claimNotice(path: string = statePath()): Promise<BuddyCheckinSaved | undefined> {
  const saved = await load(path)
  if (saved === undefined || saved.notice === undefined) return saved
  // Re-read before writing: a concurrent check-in or retry may have replaced
  // the row since the first read, and its results must survive the claim.
  const latest = await load(path)
  if (latest === undefined) return saved
  if (latest.notice === undefined) return latest
  const { notice: _claimed, ...withoutNotice } = latest
  try {
    await save(withoutNotice, path)
  } catch {
    // A failed claim only costs a repeat toast, never the day's results.
  }
  return latest
}

/**
 * Retry the accounts that failed in today's startup attempt.
 *
 * An account that already succeeded today is never re-requested: a credential
 * that became unreadable later must not demote it.
 */
export async function retryFailed(path: string = statePath(), opts: BuddyCheckinDiscoveryOptions = {}): Promise<BuddyCheckinSaved> {
  const previous = await load(path)
  if (previous === undefined || previous.day !== today()) return await run(path, opts)
  const { credentials, unreadable } = await discover(authDirsFor(), opts)
  const accountByUid = new Map(credentials.map(account => [account.uid, account]))
  const retried = await Promise.all(
    previous.results
      .filter(row => row.state === 'failed')
      .flatMap(row => {
        const account = accountByUid.get(row.uid)
        return account === undefined ? [] : [check(account)]
      }),
  )
  const replacements = new Map(retried.map(row => [row.uid, row]))
  const unreadableByUid = new Map(unreadable.map(entry => [entry.uid, entry.reason]))
  const priorByUid = new Map(previous.results.map(row => [row.uid, row]))
  const uids = new Set([...accountByUid.keys(), ...priorByUid.keys()])
  const results = [...uids]
    .map(uid => {
      const prior = priorByUid.get(uid)
      if (prior !== undefined && prior.state !== 'failed') return prior
      const replacement = replacements.get(uid)
      if (replacement !== undefined) return replacement
      if (accountByUid.has(uid)) return prior
      const reason = unreadableByUid.get(uid)
      return reason === undefined
        ? prior
        : { uid, state: 'failed' as const, at: new Date().toISOString(), error: reason }
    })
    .filter((row): row is BuddyCheckinResult => row !== undefined)
  return await save({
    day: previous.day,
    checkedAt: new Date().toISOString(),
    results,
    ...previous.balanceCheckedAt !== undefined ? { balanceCheckedAt: previous.balanceCheckedAt } : {},
  }, path)
}
