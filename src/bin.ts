#!/usr/bin/env node
/**
 * Standalone status/diagnostics CLI for the dsh-buddy-suite bundle.
 *
 * Boot-free: every command reads the machine's state directly, so it works
 * whether or not a DSH process is running the plugin.
 */

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { WorkBuddyCredentialStore, workbuddyOwnAuthPath } from './auth.ts'
import { classifyWorkBuddyFailure, healthStateOf, WorkBuddyUpstreamClient } from './upstream.ts'
import { FALLBACK_WORKBUDDY_AI_MODELS, FALLBACK_WORKBUDDY_MODELS } from './catalog.ts'
import { WORKBUDDY_CONNECT_VERSION } from './version.ts'
import { isHeartbeatProcessAlive, readHostHeartbeat, workbuddyHostHeartbeatPath } from './host-heartbeat.ts'
import { atRestKeyProviderFor } from './desktop-credential-protection.ts'
import { CN_VARIANT, variantFor, WORKBUDDY_VARIANTS, type WorkBuddyVariant } from './variants.ts'
import { resolveAppVersion } from './app-version.ts'
import { documentOf, load, run as runToday, status } from './checkin.ts'
import type { WorkBuddyHealthState, WorkBuddyLastError } from './status-paths.ts'

type Action = 'doctor' | 'logout' | 'status' | 'checkin'

const JSON_SCHEMA_VERSION = 1

/** Remove token-like strings from an unexpected diagnostic message. */
function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
}

/**
 * Object keys that must never appear in a diagnostics document.
 *
 * The diagnostic JSON is meant to be pasted into an issue, so the stripping is
 * by key *and* by suffix: `probeKey` (the in-process control secret),
 * `accessToken`/`refreshToken` (session material), `atRestSecretKey` (the
 * decryption key) and anything else ending in token/key/secret. A new field
 * added under one of those names is stripped without anyone remembering to
 * update an allow-list — the failure mode is a field missing from the report,
 * never a secret in it.
 */
const SECRET_KEY_EXACT: ReadonlySet<string> = new Set([
  'probeKey',
  'token',
  'secret',
  'password',
  'credential',
  'authorization',
])

/** Whether a diagnostics key names secret material. */
function isSecretKey(key: string): boolean {
  // Any `*Key` suffix is stripped too: `probeKey`, `apiKey`, `accessKey`, and
  // `atRestSecretKey` all end in "Key", and a diagnostics document has no
  // legitimate field that does.
  return SECRET_KEY_EXACT.has(key) || /(?:token|secret|password|key)$/iu.test(key)
}

/** Redact token-shaped content from one string value. */
function scrubString(value: string): string {
  return value
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
}

/**
 * Strip every secret from a diagnostics document, recursively.
 *
 * Exported so the guarantee can be asserted directly: a test hands this
 * function a document that *does* carry `probeKey` and token fields and checks
 * the result, rather than trusting that today's report builder happens to omit
 * them.
 */
export function stripDiagnosticSecrets(value: unknown): unknown {
  if (typeof value === 'string') return scrubString(value)
  if (Array.isArray(value)) return value.map(entry => stripDiagnosticSecrets(entry))
  if (typeof value !== 'object' || value === null) return value
  const stripped: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretKey(key)) continue
    stripped[key] = stripDiagnosticSecrets(entry)
  }
  return stripped
}

function printHelp(): void {
  process.stdout.write([
    'Usage: dsh-buddy-suite <doctor|status|checkin|logout> [--provider <id>] [--json]',
    '',
    '  doctor    secret-free sign-in and environment diagnostics',
    '  status    sign-in state, remaining WorkBuddy credit, and host-bundle health',
    '  checkin   run today\'s daily check-in for every account on this machine',
    '  logout    remove the plugin-owned credential copy (the desktop app keeps its sign-in)',
    '',
    '  --provider  which product to inspect; defaults to workbuddy',
    `              one of: ${WORKBUDDY_VARIANTS.map(variant => variant.id).join(', ')}`,
    '  --json      emit one secret-free JSON document (doctor/status/checkin only)',
    '',
  ].join('\n'))
}

/**
 * Emit one JSON document.
 *
 * Every JSON path runs through {@link stripDiagnosticSecrets}: the report is
 * designed to be shared, so the removal is a property of printing rather than
 * of each builder remembering it.
 */
function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(stripDiagnosticSecrets(value))}\n`)
}

/**
 * One variant's store plus the client that performs its refreshes.
 *
 * The key provider is built by the same shared helper the plugin host uses,
 * so the CLI's `doctor`/`status` and the browser card can never disagree
 * about which product's Electron a variant resolves.
 */
function makeStore(variant: WorkBuddyVariant): WorkBuddyCredentialStore {
  const client = new WorkBuddyUpstreamClient()
  return new WorkBuddyCredentialStore({
    variant,
    refresh: credential => client.refreshToken(credential),
    keyProvider: atRestKeyProviderFor(variant),
  })
}

/** The plugin-owned credential copy for one variant, for display. */
function ownAuthPath(variant: WorkBuddyVariant): string {
  return makeStore(variant).ownAuthPath()
}

/** Fallback roster size for one variant. */
function fallbackCount(variant: WorkBuddyVariant): number {
  return variant.id === CN_VARIANT.id ? FALLBACK_WORKBUDDY_MODELS.length : FALLBACK_WORKBUDDY_AI_MODELS.length
}

async function doctor(jsonOutput: boolean, variant: WorkBuddyVariant): Promise<number> {
  const store = makeStore(variant)
  const authStatus = await store.status()
  const desktopPresent = await store.desktopFilePresent()
  const desktopFormat = await store.desktopAuthFormat()
  // Name the file that was actually hit (e.g. the XDG data-home copy), falling
  // back to the first *possible* location when none exists so the hint still
  // says where to point the env var at.
  const desktopPath = await store.resolvedDesktopAuthPath() ?? store.desktopAuthPath()
  const heartbeat = await readHostHeartbeat()
  const hostAlive = heartbeat !== undefined && isHeartbeatProcessAlive(heartbeat)
  const appVersion = variant.region === 'global' ? await resolveAppVersion() : undefined
  // A signed-out state beside an encrypted file usually means the unlock
  // failed, not that nobody is signed in: the status reason carries the real
  // cause, it is promoted to the first hint, and the generic "sign in again"
  // hint is suppressed.
  const decryptionNote = authStatus.state === 'signed-out' && desktopFormat === 'encrypted' && authStatus.reason !== undefined
    ? `Encrypted desktop credential could not be used: ${authStatus.reason}`
    : undefined
  // Boot-free tri-state health. Two facts are provable offline: a signed-in
  // credential is `plugin_ok`, and a desktop file in a format this plugin
  // understands neither as plaintext nor as its known encrypted shape is
  // `upstream_changed` — the app changed its own storage format, which no
  // credential fix can undo. `doctor` deliberately sends no request, so it can
  // never report a transport-level `upstream_changed`; `status` performs the
  // live read that can.
  const health: WorkBuddyHealthState = desktopFormat === 'unrecognized'
    ? 'upstream_changed'
    : authStatus.state === 'signed-in' ? 'plugin_ok' : 'credential_invalid'
  const report = {
    schemaVersion: JSON_SCHEMA_VERSION,
    package: 'dsh-buddy-suite',
    version: WORKBUDDY_CONNECT_VERSION,
    node: process.version,
    provider: variant.id,
    displayName: variant.displayName,
    health,
    desktopAuthFile: {
      path: desktopPath ?? `(no platform default; set ${variant.env})`,
      present: desktopPresent,
      // How the file reads on disk: absent | plaintext | encrypted |
      // unrecognized. "encrypted" is a healthy state, not an error.
      format: desktopFormat,
    },
    ownAuthFile: ownAuthPath(variant),
    ...appVersion === undefined ? {} : {
      catalogUserAgent: {
        version: appVersion.version,
        source: appVersion.source,
        ...appVersion.bundle === undefined ? {} : { bundle: appVersion.bundle },
      },
    },
    hostHeartbeat: {
      path: workbuddyHostHeartbeatPath(),
      present: heartbeat !== undefined,
      ...heartbeat === undefined ? {} : { registeredAt: heartbeat.registeredAt, pid: heartbeat.pid },
      processAlive: hostAlive,
    },
    signIn: authStatus.state,
    fallbackModels: fallbackCount(variant),
    hints: [
      ...decryptionNote !== undefined ? [decryptionNote]
        : authStatus.state === 'signed-out' ? [`Sign in once in the ${variant.appName} desktop app, then run status again.`] : [],
      ...desktopPresent ? [] : [`No ${variant.appName} desktop auth file at the expected path; set ${variant.env} if it lives elsewhere.`],
      ...desktopFormat === 'unrecognized'
        ? [`The ${variant.appName} desktop auth file is in a format this plugin does not recognize; it changed shape upstream. Use the official ${variant.appName} client.`]
        : [],
      ...hostAlive ? [] : ['Host bundle not running in this DSH profile (or the process exited). The browser card and provider are unavailable until DSH starts the plugin.'],
    ],
  }
  if (jsonOutput) {
    printJson({ ...report, ...decryptionNote === undefined ? {} : { decryptionNote } })
  } else {
    process.stdout.write([
      `${variant.displayName} Suite ${WORKBUDDY_CONNECT_VERSION} on ${process.version}`,
      `Health: ${health}`,
      `Desktop auth file: ${report.desktopAuthFile.present ? 'present' : 'missing'} — ${desktopFormat} (${report.desktopAuthFile.path})`,
      `Host bundle: ${hostAlive ? `running (pid ${heartbeat!.pid})` : heartbeat !== undefined ? 'stale heartbeat (process exited)' : 'not started'}`,
      `Sign-in state: ${report.signIn}`,
      `Static fallback models: ${report.fallbackModels}`,
      ...appVersion === undefined ? [] : [`Catalog User-Agent version: ${appVersion.version} (${appVersion.source})`],
      ...report.hints.map(hint => `Hint: ${hint}`),
      '',
    ].join('\n'))
  }
  return authStatus.state === 'signed-in' && desktopPresent ? 0 : 1
}

async function statusCommand(jsonOutput: boolean, variant: WorkBuddyVariant): Promise<number> {
  const store = makeStore(variant)
  const client = new WorkBuddyUpstreamClient()
  const authStatus = await store.status()
  const heartbeat = await readHostHeartbeat()
  const hostAlive = heartbeat !== undefined && isHeartbeatProcessAlive(heartbeat)
  const hostState = hostAlive ? 'running' : heartbeat !== undefined ? 'stale' : 'not-started'
  if (authStatus.state !== 'signed-in') {
    // Health is `credential_invalid` by definition: no usable credential means
    // no plugin action can help until the user signs in (or fixes the file).
    const health: WorkBuddyHealthState = 'credential_invalid'
    const lastError: WorkBuddyLastError = {
      stage: 'credential',
      code: authStatus.reasonCode === 'encrypted-credential-unreadable'
        ? 'CREDENTIAL_DECRYPT_FAILED'
        : 'CREDENTIAL_MISSING',
      message: authStatus.reason ?? (authStatus.reasonCode ?? 'no usable credential'),
    }
    if (jsonOutput) {
      printJson({
        schemaVersion: JSON_SCHEMA_VERSION,
        package: 'dsh-buddy-suite',
        version: WORKBUDDY_CONNECT_VERSION,
        provider: variant.id,
        status: 'signed-out',
        hostBundle: hostState,
        health,
        lastError,
      })
    } else {
      process.stdout.write(`${variant.displayName} Suite: signed out\nHealth: ${health} (${lastError.code}: ${lastError.message})\nHost bundle: ${hostState}\n`)
    }
    return 1
  }
  // Health starts at full and is lowered by the live credit read below: a
  // signed-in account whose upstream no longer answers is `upstream_changed`,
  // which is exactly the case a "signed in" line alone would misreport.
  let health: WorkBuddyHealthState = 'plugin_ok'
  let lastError: WorkBuddyLastError | undefined
  let credits: { total: number; unlimited?: true; error?: string } | undefined
  try {
    const credential = await store.current()
    if (credential !== undefined) {
      const fetched = await client.fetchCredits(credential)
      credits = {
        total: fetched.total,
        ...fetched.unlimited === true ? { unlimited: true } : {},
      }
    }
  } catch (error: unknown) {
    lastError = classifyWorkBuddyFailure('credits', error)
    health = healthStateOf(lastError.code)
    credits = { total: 0, error: safeMessage(error) }
  }
  const expiresAt = authStatus.expiresAtMs !== undefined ? new Date(authStatus.expiresAtMs).toISOString() : undefined
  if (jsonOutput) {
    printJson({
      schemaVersion: JSON_SCHEMA_VERSION,
      package: 'dsh-buddy-suite',
      version: WORKBUDDY_CONNECT_VERSION,
      provider: variant.id,
      status: 'signed-in',
      ...expiresAt === undefined ? {} : { accessTokenExpires: expiresAt },
      ...authStatus.nickname === undefined ? {} : { nickname: authStatus.nickname },
      ...authStatus.domain === undefined || authStatus.domain === '' ? {} : { domain: authStatus.domain },
      source: authStatus.source,
      credits: credits?.total,
      ...credits?.unlimited === true ? { creditsUnlimited: true } : {},
      ...credits?.error === undefined ? {} : { creditsError: credits.error },
      hostBundle: hostState,
      health,
      ...lastError === undefined ? {} : { lastError },
    })
    return 0
  }
  process.stdout.write([
    `${variant.displayName} Suite: signed in${authStatus.nickname === undefined ? '' : ` as ${authStatus.nickname}`}`,
    `Health: ${health}${lastError === undefined ? '' : ` (${lastError.code} during ${lastError.stage}: ${lastError.message})`}`,
    ...expiresAt === undefined ? [] : [`Access token expires ${expiresAt} (refresh is automatic)`],
    credits?.error !== undefined
      ? `Remaining credit: unavailable (${credits.error})`
      // An uncapped quota has no balance to print; showing 0 would read as
      // "exhausted".
      : credits?.unlimited === true
        ? 'Remaining credit: unlimited'
        : `Remaining credit: ${credits?.total ?? 'unknown'}`,
    `Host bundle: ${hostAlive ? `running (pid ${heartbeat!.pid})` : hostState === 'stale' ? 'stale heartbeat (DSH process exited)' : 'not started in this profile'}`,
    'Client card: load failures are logged to the browser console only; the host provider is unaffected.',
    '',
  ].join('\n'))
  return 0
}

/**
 * Run today's check-in and report every account's outcome.
 *
 * The command is idempotent: an account already signed or already credited
 * today is carried over untouched, so it is safe to run repeatedly. Accounts
 * whose credential could not be read are reported as failures with the
 * reason, which is what makes "sign in again in the app" reachable from a
 * terminal.
 */
async function checkinCommand(jsonOutput: boolean): Promise<number> {
  const saved = await runToday()
  const summary = documentOf(saved)
  const rows = saved.results.map(row => ({
    uid: row.uid,
    ...row.nickname === undefined ? {} : { nickname: row.nickname },
    state: row.state,
    at: row.at,
    ...row.credit === undefined ? {} : { credit: row.credit },
    ...row.balance === undefined ? {} : { balance: row.balance },
    ...row.error === undefined ? {} : { error: row.error },
  }))
  const ok = saved.results.filter(row => row.state !== 'failed').length
  if (jsonOutput) {
    printJson({
      schemaVersion: JSON_SCHEMA_VERSION,
      package: 'dsh-buddy-suite',
      version: WORKBUDDY_CONNECT_VERSION,
      day: summary.day,
      checkedAt: summary.checkedAt,
      status: summary.status,
      signed: ok,
      total: saved.results.length,
      results: rows,
    })
    return ok === saved.results.length ? 0 : 1
  }
  process.stdout.write([
    `WorkBuddy daily check-in for ${summary.day}: ${ok}/${saved.results.length} account(s) succeeded`,
    ...saved.results.map(row => {
      const who = row.nickname ?? row.uid
      const outcome = row.state === 'signed'
        ? `signed${row.credit === undefined ? '' : ` (+${row.credit} credits)`}`
        : row.state === 'already' ? 'already signed in the app' : `failed (${row.error ?? 'unknown'})`
      const credits = row.balance === undefined ? '' : ` — ${row.balance} credits remaining`
      return `  ${who}: ${outcome}${credits}`
    }),
    '',
  ].join('\n'))
  return ok === saved.results.length ? 0 : 1
}

/** Execute one boot-free command. */
export async function run(argv: readonly string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp()
    return 0
  }
  const [rawAction, ...flags] = argv
  const actions: readonly Action[] = ['doctor', 'logout', 'status', 'checkin']
  if (!actions.includes(rawAction as Action)) {
    process.stderr.write(`dsh-buddy-suite: expected doctor, status, checkin, or logout; got ${JSON.stringify(rawAction)}\n`)
    return 1
  }
  const action = rawAction as Action
  const jsonOutput = flags.includes('--json')

  // `--provider <id>` (or `--provider=<id>`); absent means the CN provider, so
  // every existing invocation keeps its behaviour.
  let providerId: string | undefined
  const rest: string[] = []
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index]!
    if (flag === '--provider') {
      providerId = flags[index + 1]
      index += 1
      continue
    }
    if (flag.startsWith('--provider=')) {
      providerId = flag.slice('--provider='.length)
      continue
    }
    rest.push(flag)
  }
  const variant = providerId === undefined ? CN_VARIANT : variantFor(providerId)
  if (variant === undefined) {
    process.stderr.write(
      `dsh-buddy-suite: unknown provider ${JSON.stringify(providerId)}; expected one of ${WORKBUDDY_VARIANTS.map(v => v.id).join(', ')}\n`,
    )
    return 1
  }
  const unknown = rest.filter(flag => flag !== '--json')
  if (unknown.length > 0 || (jsonOutput && action === 'logout')) {
    process.stderr.write(`dsh-buddy-suite: invalid options for ${action}: ${flags.join(' ')}\n`)
    return 1
  }
  try {
    switch (action) {
      case 'doctor':
        return await doctor(jsonOutput, variant)
      case 'status':
        return await statusCommand(jsonOutput, variant)
      case 'checkin':
        return await checkinCommand(jsonOutput)
      case 'logout': {
        const store = makeStore(variant)
        // Only this variant's plugin-owned copy is removed: the desktop app's
        // own sign-in is never touched.
        await store.logout()
        process.stdout.write(
          `${variant.displayName} Suite: removed ${store.ownAuthPath()}; the desktop app's sign-in is untouched\n`,
        )
        return 0
      }
    }
  } catch (error: unknown) {
    process.stderr.write(`dsh-buddy-suite: ${action} failed: ${safeMessage(error)}\n`)
    return 1
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await run(process.argv.slice(2))
}
