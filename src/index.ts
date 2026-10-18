/**
 * DSH Buddy Suite: one bundle that does both WorkBuddy jobs.
 *
 * The two halves are deliberately independent, and each can fail without the
 * other:
 *
 * - the **model provider** half registers one provider per product variant —
 *   `workbuddy` for the CN app and `workbuddy-ai` for the international one —
 *   so WorkBuddy models appear in the DSH picker. Streaming, tool calls,
 *   compaction, and permissions stay Harness-owned.
 * - the **check-in** half runs the WorkBuddy CN daily check-in for every
 *   account that ever signed in on this machine, at DSH startup and on panel
 *   interaction, and reports the outcome through a browser panel. It is
 *   CN-only by measurement and registers no provider.
 *
 * Nothing is shared between them except the credential-decryption module,
 * which both need for the same reason: WorkBuddy 5.6 seals its auth files at
 * rest, and the key lives in the app's own Electron binary.
 *
 * The two halves are assembled by the same `apply`, but neither can stop the
 * other from starting: a user with no WorkBuddy app installed sees no model
 * group and no check-in entry, and a user with only the CN app sees only that
 * group plus the check-in.
 *
 * @module dsh-buddy-suite
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-attachment'
import { WorkBuddyCredentialStore, type WorkBuddyCredential, type WorkBuddyStoreOptions } from './auth.ts'
import { atRestKeyProviderFor, WorkBuddyAtRestKeyProvider } from './desktop-credential-protection.ts'
import { FALLBACK_WORKBUDDY_AI_MODELS, FALLBACK_WORKBUDDY_MODELS, WorkBuddyCatalog } from './catalog.ts'
import { workbuddyCatalogPath, WorkBuddyCatalogStore } from './catalog-store.ts'
import { WorkBuddyVisibilityStore, workbuddyVisibilityPath } from './visibility-store.ts'
import { createWorkBuddyAdapter } from './adapter.ts'
import { createWorkBuddyShim } from './shim.ts'
import { WorkBuddyProbeService } from './probe-service.ts'
import { newestFirst, WorkBuddyProbeStore, workbuddyProbePath } from './probe-store.ts'
import { WorkBuddyUpstreamClient } from './upstream.ts'
import { piAiVersionWarning } from './pi-ai-guard.ts'
import { registerWorkBuddyStatusRoute } from './web-status.ts'
import { registerWorkBuddyUpdateRoute } from './update-route.ts'
import { createProbeKey, registerWorkBuddyProbeRoute } from './probe-route.ts'
import type { WorkBuddyModelInfo } from './catalog.ts'
import type { WorkBuddyWebCatalog, WorkBuddyWebProbeSection } from './status-paths.ts'
import { clearHostHeartbeat, writeHostHeartbeat } from './host-heartbeat.ts'
import { WORKBUDDY_CONNECT_VERSION } from './version.ts'
import { legacySettingsOf } from './legacy-settings.ts'
import { CN_VARIANT, WORKBUDDY_VARIANTS, type WorkBuddyVariant } from './variants.ts'
import { createBuddyCheckinStartup, registerBuddyCheckinRoutes } from './checkin-routes.ts'
import { readUiPreferences, writeUiPreferences } from './ui-preferences.ts'

export { WORKBUDDY_PROVIDER, WORKBUDDY_STREAM_IDLE_TIMEOUT_MS, createWorkBuddyAdapter, type WorkBuddyAdapter } from './adapter.ts'
export { createWorkBuddyShim, type WorkBuddyShim } from './shim.ts'
export {
  FALLBACK_WORKBUDDY_AI_MODELS,
  FALLBACK_WORKBUDDY_MODELS,
  WorkBuddyCatalog,
  type WorkBuddyModelInfo,
} from './catalog.ts'
export {
  WORKBUDDY_CATALOG_FILENAME,
  workbuddyCatalogPath,
  WorkBuddyCatalogStore,
} from './catalog-store.ts'
export {
  WORKBUDDY_VISIBILITY_FILENAME,
  WorkBuddyVisibilityStore,
  workbuddyVisibilityPath,
} from './visibility-store.ts'
export {
  fingerprintModel,
  WorkBuddyProbeStore,
  workbuddyProbePath,
  WORKBUDDY_PROBE_FILENAME,
  type WorkBuddyProbeRecord,
  type WorkBuddyProbeValidation,
} from './probe-store.ts'
export {
  PROBE_EFFORT_CANDIDATES,
  randomSentinel,
  probeModel,
  type ProbeAttempt,
  type ProbeOutcome,
  type ProbeSender,
} from './probe.ts'
export { WorkBuddyProbeService, type WorkBuddyProbeStatus } from './probe-service.ts'
export {
  AI_VARIANT,
  CN_VARIANT,
  variantFor,
  WORKBUDDY_VARIANTS,
  type WorkBuddyVariant,
} from './variants.ts'
export {
  appUserAgent,
  installedAppVersion,
  readBundleVersion,
  resolveAppVersion,
  validAppVersion,
  WORKBUDDY_APP_VERSION_FILENAME,
  type AppVersionInfo,
  type WorkBuddyAppVersionSource,
} from './app-version.ts'
export {
  CN_APP_VERSION_FILENAME,
  FALLBACK_CN_APP_VERSION,
  chatUserAgent,
  fallbackChatIdentity,
  readCliVersion,
  resolveChatIdentity,
  validCliVersion,
  type ChatIdentity,
  type ResolveChatIdentityOptions,
} from './client-identity.ts'
export {
  defaultDesktopAuthCandidates,
  defaultDesktopAuthPath,
  desktopAuthCandidatesFor,
  parseWorkBuddyAuth,
  WORKBUDDY_AUTH_FILE_ENV,
  WORKBUDDY_AUTH_FILENAME,
  WorkBuddyCredentialStore,
  workbuddyOwnAuthPath,
  type WorkBuddyAuthStatus,
  type WorkBuddyCredential,
} from './auth.ts'
export {
  classifyUpstreamError,
  modelWithCurrentPromotion,
  normalizeCredits,
  parseModelCatalog,
  prepareChatBody,
  prepareCnChatBody,
  prepareInternationalChatBody,
  regionOf,
  WorkBuddyUpstreamClient,
  type UpstreamErrorKind,
  type WorkBuddyCatalogFetch,
  type WorkBuddyChatResult,
  type WorkBuddyCredits,
  type WorkBuddyEffort,
  type WorkBuddyModelBilling,
  type WorkBuddyModelReasoning,
  type WorkBuddyPromotion,
  type WorkBuddyRefreshOutcome,
  type WorkBuddyUpstreamModel,
} from './upstream.ts'
export {
  WORKBUDDY_HOST_HEARTBEAT_FILENAME,
  clearHostHeartbeat,
  isHeartbeatProcessAlive,
  processStartTimeMs,
  readHostHeartbeat,
  workbuddyHostHeartbeatPath,
  type WorkBuddyHostHeartbeat,
} from './host-heartbeat.ts'
export {
  authDirsFor,
  authDirFor,
  check,
  claimNotice,
  discover,
  documentOf,
  ensureToday,
  load,
  refreshBalances,
  retryFailed,
  run,
  statePath,
  status,
  today,
  type BuddyCheckinCredential,
  type BuddyCheckinDiscovery,
  type BuddyCheckinResult,
  type BuddyCheckinSaved,
  type BuddyCheckinUnreadable,
} from './checkin.ts'
export {
  BUDDY_CHECKIN_PATH,
  BUDDY_CHECKIN_BALANCE_PATH,
  buddyCheckinBalanceHandler,
  buddyCheckinRetry,
  buddyCheckinStatus,
  buddyCheckinStatusHandler,
  createBuddyCheckinStartup,
  registerBuddyCheckinRoutes,
  type BuddyCheckinRouteOptions,
} from './checkin-routes.ts'
export {
  BUDDY_CHECKIN_FILENAME,
} from './state-paths.ts'
export type {
  BuddyCheckinDocument,
  BuddyCheckinRow,
  WorkBuddyWebStatus,
} from './status-paths.ts'
export { BUDDY_SUITE_VERSION, WORKBUDDY_CONNECT_VERSION } from './version.ts'

/** Stable Cordis plugin name. */
export const name = 'llm-workbuddy'

/** The model registry required before the provider can register. */
export const inject = ['llm']

/**
 * Settings namespace owning the CN card's section.
 *
 * DSH 0.1.2 dropped the `settingsNamespace()` branding function: a namespace is
 * now a nominal string, validated by the type system where it is used rather
 * than at runtime by a function call.
 */
export const WORKBUDDY_SETTINGS_NS = 'workbuddy' as SettingsNamespace

/** Settings namespace owning the international section. */
export const WORKBUDDY_AI_SETTINGS_NS = 'workbuddy-ai' as SettingsNamespace

/**
 * How often the credential files are re-checked, in milliseconds.
 *
 * A startup-only catalog fetch cannot notice a sign-in that happens while DSH
 * is already running, so the model group would not appear until a restart.
 * This poll is a cheap existence/parse read of at most a few local files: it
 * never contacts the network and never runs a reasoning probe.
 *
 * `DSH_WORKBUDDY_POLL_MS` overrides it. That exists so the sweep can be
 * exercised end to end in tests; it is not a product setting and no UI
 * exposes it. The value is clamped so a mistaken override cannot turn the
 * poll into a busy loop.
 */
const CREDENTIAL_POLL_MS = 30_000

/** Floor and ceiling for the overridable poll interval. */
const MIN_POLL_MS = 100
const MAX_POLL_MS = 24 * 60 * 60 * 1000

/** Resolve the sweep interval, honoring the override when it is usable. */
function credentialPollMs(): number {
  const override = Number(process.env['DSH_WORKBUDDY_POLL_MS'])
  if (!Number.isFinite(override) || override < MIN_POLL_MS) return CREDENTIAL_POLL_MS
  return Math.min(override, MAX_POLL_MS)
}

/**
 * How long to wait before retrying a catalog fetch that failed.
 *
 * The credential sweep deliberately does not re-fetch a catalog it already has
 * (a same-identity token rotation carries no new model information). But a
 * *failed* fetch must not be treated the same way: without a retry, one
 * transient network blip at startup would leave the group on the built-in
 * fallback roster until the user noticed and pressed refresh.
 */
const CATALOG_RETRY_SWEEPS = 10

/** Plugin configuration. */
export interface Config {
  /** Explicit WorkBuddy (CN) desktop auth-file path, overriding env and platform defaults. */
  authFile?: string
  /** Explicit WorkBuddy AI (international) desktop auth-file path. */
  authFileAI?: string
  /**
   * Whether the user has authorized sending probe requests about reasoning
   * efforts. Off by default: a probe spends real credit, so nothing is sent
   * until the user explicitly agrees.
   */
  probeConsent?: boolean
  /** Use the largest context window the international catalog explicitly offers. */
  useMaximumContextWindow?: boolean
}

/** Explicit CN desktop auth-file path (shared by the plugin schema and its section). */
const AUTH_FILE_FIELD = z.string().description('WorkBuddy desktop auth file (defaults to the app\'s own location)')
/** Explicit international desktop auth-file path. */
const AUTH_FILE_AI_FIELD = z.string().description('WorkBuddy AI desktop auth file (defaults to the app\'s own location)')
/** Probe authorization (shared by the plugin schema and the CN section). */
const PROBE_CONSENT_FIELD = z.boolean().default(false)
  .description('Authorize reasoning-effort probes (each probe sends real requests that may consume credit)')
const MAXIMUM_CONTEXT_WINDOW_FIELD = z.boolean().default(true)
  .description('Use the largest context window declared by WorkBuddy AI when alternatives are available (on by default)')

export const Config: z<Config> = z.object({
  authFile: AUTH_FILE_FIELD,
  authFileAI: AUTH_FILE_AI_FIELD,
  probeConsent: PROBE_CONSENT_FIELD,
  useMaximumContextWindow: MAXIMUM_CONTEXT_WINDOW_FIELD,
})

/** The CN side's settings section: only the fields that side edits. */
const CN_SECTION: z<Config> = z.object({
  authFile: AUTH_FILE_FIELD,
  probeConsent: PROBE_CONSENT_FIELD,
})

/** The international card's settings section and its context-window preference. */
const AI_SECTION: z<Config> = z.object({
  authFileAI: AUTH_FILE_AI_FIELD,
  useMaximumContextWindow: MAXIMUM_CONTEXT_WINDOW_FIELD,
})

/** One variant's live runtime, assembled by {@link createVariantRuntime}. */
interface VariantRuntime {
  variant: WorkBuddyVariant
  store: WorkBuddyCredentialStore
  client: WorkBuddyUpstreamClient
  catalog: WorkBuddyCatalog
  probeStore: WorkBuddyProbeStore
  probeService: WorkBuddyProbeService
  /** The last catalogs that loaded, keyed by account. */
  savedCatalogs: WorkBuddyCatalogStore
  /** This variant's per-account hidden-model preferences. */
  visibilityStore: WorkBuddyVisibilityStore
  /**
   * The visibility account key currently in effect (`uid:enterpriseId`), or
   * undefined when signed out or the credential carries no uid.
   */
  account: () => string | undefined
  /** The static roster this variant falls back to. */
  fallback: readonly WorkBuddyModelInfo[]
  /**
   * Where the served models came from, in degradation order:
   * `live` → `saved` → `fallback`.
   */
  catalogSource: 'live' | 'saved' | 'fallback'
  /** When the served catalog was fetched, for `live` and `saved`. */
  catalogFetchedAtMs: number | undefined
  /** Why the last catalog attempt failed, when it did. */
  catalogError: string | undefined
  /** When the last catalog attempt started, for the retry backoff. */
  lastFetchAtMs: number
  /**
   * Bumped whenever this variant's catalog generation changes. A request
   * carries the generation it started under and refuses to write back if the
   * generation has moved on, so a slow answer can never resurrect data the
   * plugin has since decided to drop.
   */
  catalogGeneration: number
  /** The in-flight catalog fetch, scoped to the identity it began under. */
  inflightFetch: CatalogFetch | undefined
  /** Notify the model directory that this variant's answers changed. */
  invalidate: () => void
  /** Whether the provider registered successfully. */
  registered: boolean
}

/** One catalog request plus the identity state it is allowed to update. */
interface CatalogFetch {
  identity: string
  generation: number
  controller: AbortController
  promise: Promise<void>
}

/** Stable identity key used by credentials, probe records, and catalog entries. */
function credentialIdentity(credential: Pick<WorkBuddyCredential, 'uid' | 'enterpriseId'>): string {
  return `${credential.uid}:${credential.enterpriseId ?? ''}`
}

/**
 * The account key model-visibility preferences are stored under: the stable
 * identity, but only when it carries a uid.
 *
 * A credential whose desktop document carried no `account.uid` normalizes to
 * an empty string; keying preferences on the resulting `":enterpriseId"` would
 * silently share one bucket between every such account. Those accounts get no
 * per-account preferences at all — everything stays visible and the control
 * route explains the refusal — which is the only honest degradation.
 */
export function visibilityAccountOf(credential: Pick<WorkBuddyCredential, 'uid' | 'enterpriseId'>): string | undefined {
  return credential.uid === '' ? undefined : credentialIdentity(credential)
}

/** Read the configured explicit auth-file path for one variant. */
function configuredAuthFile(config: Config, variant: WorkBuddyVariant): string | undefined {
  return variant.id === CN_VARIANT.id ? config.authFile : config.authFileAI
}

/** The static catalog a variant serves before its first successful fetch. */
function fallbackFor(variant: WorkBuddyVariant): readonly WorkBuddyModelInfo[] {
  return variant.id === CN_VARIANT.id ? FALLBACK_WORKBUDDY_MODELS : FALLBACK_WORKBUDDY_AI_MODELS
}

/** Build one variant's stores and probe state. */
function createVariantRuntime(
  config: Config,
  variant: WorkBuddyVariant,
  current: () => Config,
  identityOf: (variantId: string) => string | undefined,
  accountOf: (variantId: string) => string | undefined,
  keyProvider: WorkBuddyStoreOptions['keyProvider'],
): VariantRuntime {
  const client = new WorkBuddyUpstreamClient()
  const configured = configuredAuthFile(config, variant)
  const store = new WorkBuddyCredentialStore({
    variant,
    ...configured === undefined ? {} : { desktopPath: configured },
    ...keyProvider === undefined ? {} : { keyProvider },
    refresh: credential => client.refreshToken(credential),
  })
  const fallback = fallbackFor(variant)
  const catalog = new WorkBuddyCatalog(fallback)
  if (variant.id !== CN_VARIANT.id) catalog.setUseMaximumContextWindow(config.useMaximumContextWindow === true)
  // Start hidden: a variant must serve no models until an account has actually
  // been adopted, so a signed-out variant is empty rather than showing a roster
  // whose models could only fail.
  catalog.setVisible(false)
  const probeStore = new WorkBuddyProbeStore({
    pluginVersion: WORKBUDDY_CONNECT_VERSION,
    path: workbuddyProbePath(variant.probeFilename),
  })
  // One file per variant: the two endpoints disagree about rates and windows
  // for shared model ids, so a saved CN roster must never be served as an
  // international one.
  const savedCatalogs = new WorkBuddyCatalogStore(
    workbuddyCatalogPath(variant.catalogFilename),
  )
  const visibilityStore = new WorkBuddyVisibilityStore(
    workbuddyVisibilityPath(variant.visibilityFilename),
  )
  const probeService = new WorkBuddyProbeService({
    store: probeStore,
    catalog,
    credentials: store,
    client,
    // The two endpoints answer a rejected effort with different codes; each
    // runtime reads only the vocabulary measured on its own endpoint.
    region: variant.id === CN_VARIANT.id ? 'cn' : 'global',
    consent: () => current().probeConsent === true,
    // Observations are per account: one account's detected levels never answer
    // for another's.
    account: () => identityOf(variant.id),
  })
  return {
    variant,
    store,
    client,
    catalog,
    probeStore,
    probeService,
    savedCatalogs,
    visibilityStore,
    account: () => accountOf(variant.id),
    fallback,
    catalogSource: 'fallback',
    catalogFetchedAtMs: undefined,
    catalogError: undefined,
    lastFetchAtMs: 0,
    catalogGeneration: 0,
    inflightFetch: undefined,
    invalidate: () => {},
    registered: false,
  }
}

/** The catalog provenance the card displays. */
function catalogSection(runtime: VariantRuntime): WorkBuddyWebCatalog {
  const fetch = runtime.client.lastCatalog
  return {
    source: runtime.catalogSource,
    ...runtime.catalogFetchedAtMs === undefined ? {} : { fetchedAt: runtime.catalogFetchedAtMs },
    ...fetch?.appVersion === undefined ? {} : { appVersion: fetch.appVersion.version },
    ...runtime.catalogError === undefined ? {} : { error: runtime.catalogError },
  }
}

/**
 * Whether a model can be probed by hand: it reasons and the upstream declares
 * no effort set for it.
 *
 * Deliberately *not* filtered by whether a result already exists: dropping a
 * model once it has been detected made the list shrink with use.
 */
function isProbeCandidate(info: WorkBuddyModelInfo): boolean {
  if (info.reasoning?.supports !== true) return false
  return (info.reasoning.supportedEfforts?.length ?? 0) === 0
}

/** Compact probe state for one card: consent, candidates, observations. */
function probeSection(runtime: VariantRuntime, consent: boolean): WorkBuddyWebProbeSection {
  const models = runtime.catalog.current()
  const results = models.flatMap(info => {
    const record = runtime.probeService.recordFor(info.id)
    if (record === undefined) return []
    return [{
      id: info.id,
      name: info.name,
      validation: record.validation,
      efforts: record.efforts,
      probedAt: record.probedAtMs,
    }]
  })
  return {
    consent,
    running: runtime.probeService.isRunning(),
    candidates: models.filter(isProbeCandidate).map(info => info.id),
    // Newest first: a detection the user just ran belongs at the top.
    results: newestFirst(results),
  }
}

/**
 * Start one variant: its loopback endpoint, provider registration, and
 * configuration-card wiring.
 *
 * Registration waits for the shim to hold a port, because the provider's
 * models read the shim origin at construction time. A failure here is
 * contained to this variant: the caller logs it and the other keeps working.
 *
 * @returns whether the provider registered.
 */
async function startVariant(ctx: Context, runtime: VariantRuntime): Promise<boolean> {
  const { variant, store, client, catalog, probeService } = runtime
  const shim = createWorkBuddyShim({ store, client, catalog, logger: ctx.logger })
  try {
    await shim.ready
  } catch (error: unknown) {
    ctx.logger.error(`dsh-buddy-suite: ${variant.displayName} loopback endpoint failed to start`, error)
    return false
  }

  try {
    const workbuddy = createWorkBuddyAdapter({
      providerId: variant.id,
      displayName: variant.displayName,
      region: variant.region,
      shim,
      store,
      catalog,
      resolveAttachments: () => ctx.get('attachments'),
      resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
        attachments,
        hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
        ref,
      ),
      observe: modelId => probeService.recordFor(modelId),
      // Hidden ids resolve per read from the store by the *current* account:
      // an account switch or a toggle changes the answer after the next
      // invalidate, and a signed-out or uid-less variant hides nothing.
      hidden: () => {
        const account = runtime.account()
        return account === undefined ? [] : runtime.visibilityStore.disabled(account)
      },
    })
    runtime.invalidate = () => {
      workbuddy.invalidate()
      ctx.emit('llm/adapters-updated')
    }

    // Only the adapter registers. The plugin deliberately contributes NO
    // `registerConfigurableProviders` directory entry: the Models settings page
    // builds its rows from that registration, so omitting it keeps the
    // WorkBuddy providers off that page while the adapter keeps serving models
    // and the sections keep serving `settings.yaml` and the TUI. Nothing else
    // consumes the directory: the model picker's group headings come from the
    // adapter's own provider metadata and catalog.
    const releaseAdapter = ctx.llm.registerAdapter([variant.id], workbuddy.adapter)
    try {
      ctx.effect(() => () => {
        releaseAdapter()
        void shim.close()
      })
    } catch {
      // `ctx.effect` throws when the context is already disposed, so the
      // disposer it would have registered never runs: release this variant's
      // own registration (and its shim) here instead.
      releaseAdapter()
      void shim.close()
    }
    runtime.registered = true
    return true
  } catch (error: unknown) {
    ctx.logger.error(`dsh-buddy-suite: ${variant.displayName} provider registration failed`, error)
    void shim.close()
    return false
  }
}

/**
 * Start both halves: the model providers and the daily check-in.
 *
 * The provider half registers each variant unconditionally; what varies is
 * whether its catalog is *visible*. An empty catalog is how DSH hides a model
 * group (the host filters out groups with no models), which keeps a sign-in
 * that happens after startup working without re-registering the provider.
 *
 * The check-in half starts one attempt immediately and mounts its routes; a
 * failure there is logged and costs the panel, never the provider.
 */
export function apply(ctx: Context, config: Config): void {
  // Report a shadowed pi-ai copy once, at load: the plugin still runs, but a
  // mismatched generation otherwise surfaces only as an opaque PI_AI_ERROR on
  // the first request.
  const piAiWarning = piAiVersionWarning()
  if (piAiWarning !== undefined) ctx.logger.warn(`dsh-buddy-suite: ${piAiWarning}`)

  // Live configuration source: starts as the applied config and is replaced by
  // the settings section's source once one is installed.
  let current = (): Config => config

  /** Timers and in-flight work belonging to this plugin instance. */
  let stopped = false
  const timers: NodeJS.Timeout[] = []
  /** The account identity each variant last published a catalog for. */
  const lastIdentities = new Map<string, string>()
  /** The visibility account key each variant last adopted. */
  const lastAccounts = new Map<string, string>()

  // One at-rest key provider per variant. Product identity (env var, bundle
  // id, registry name, exe basename) lives on the variant's electron profile,
  // so each provider can only ever resolve — and execute — its own product's
  // Electron. Discovery is platform-gated; an explicit per-product env var
  // stays authoritative and never falls back.
  const atRestKeysFor = (variant: WorkBuddyVariant): WorkBuddyAtRestKeyProvider => atRestKeyProviderFor(variant)
  const runtimes = WORKBUDDY_VARIANTS.map(variant => createVariantRuntime(
    config,
    variant,
    () => current(),
    id => lastIdentities.get(id),
    id => lastAccounts.get(id),
    atRestKeysFor(variant),
  ))

  // Same-origin routes backing each Plugin-configuration card; the webServer
  // service is optional (a headless profile serves no browser).
  const probeKey = createProbeKey()
  let setMaximumContextWindow: ((enabled: boolean) => Promise<{ state: string; reason?: string }>) | undefined
  /** Whether this host's settings service carries the legacy section API. */
  let legacySettingsAvailable = false

  /**
   * Point a variant at an account identity, invalidating whatever the previous
   * one left behind.
   *
   * One helper for all four transitions (sweep sign-in, sweep sign-out, manual
   * refresh, manual refresh sign-out) because each of them used to do its own
   * partial version. Every transition bumps the catalog generation, which is
   * what makes an in-flight request from before the change refuse to write
   * back.
   *
   * Probe observations and visibility preferences are kept across an account
   * change: both stores nest them per account, so the departing account's
   * records simply stop being served and are found intact if that account
   * returns.
   */
  const adoptIdentity = (runtime: VariantRuntime, identity: string | undefined, account: string | undefined): void => {
    const id = runtime.variant.id
    const known = lastIdentities.get(id)
    if (known === identity) return
    const hadCredential = known !== undefined
    if (identity === undefined) lastIdentities.delete(id)
    else lastIdentities.set(id, identity)
    if (account === undefined) lastAccounts.delete(id)
    else lastAccounts.set(id, account)
    runtime.catalogGeneration += 1
    runtime.inflightFetch?.controller.abort()
    runtime.inflightFetch = undefined
    if (hadCredential && known !== identity) {
      runtime.invalidate()
    }
    if (identity === undefined) {
      // Signed out: hide the group, and drop the models so they are not left
      // registered-but-invisible if visibility ever flips back.
      if (known !== undefined) runtime.savedCatalogs.delete(known)
      runtime.catalog.set(runtime.fallback)
      runtime.catalogSource = 'fallback'
      runtime.catalogFetchedAtMs = undefined
      runtime.catalogError = undefined
      if (runtime.catalog.setVisible(false)) runtime.invalidate()
      return
    }
    // Serve this account's best-known catalog until a fetch lands. The saved
    // catalog is preferred over the built-in roster: the roster is a snapshot
    // taken once, while the saved one is what this account was actually served.
    const saved = runtime.savedCatalogs.get(identity)
    if (saved !== undefined) {
      runtime.catalog.set([...saved.models])
      runtime.catalogSource = 'saved'
      runtime.catalogFetchedAtMs = saved.fetchedAtMs
    } else {
      runtime.catalog.set(runtime.fallback)
      runtime.catalogSource = 'fallback'
      runtime.catalogFetchedAtMs = undefined
    }
    runtime.catalogError = undefined
    runtime.catalog.setVisible(true)
    runtime.invalidate()
  }

  ctx.inject(['webServer'], webCtx => {
    // One update route for the whole bundle: it answers this npm package's
    // public version metadata only, so it is per-plugin, not per-variant.
    registerWorkBuddyUpdateRoute(webCtx, { currentVersion: WORKBUDDY_CONNECT_VERSION })
    for (const runtime of runtimes) {
      registerWorkBuddyStatusRoute(webCtx, {
        path: runtime.variant.statusPath,
        store: runtime.store,
        client: runtime.client,
        models: () => runtime.catalog.current(),
        catalog: () => catalogSection(runtime),
        probe: () => probeSection(runtime, current().probeConsent === true),
        probeKey,
        // Both variants read the same machine-wide preference, so the composer
        // control answers consistently whichever provider is selected.
        ui: () => readUiPreferences(),
        visibility: () => {
          const account = runtime.account()
          return account === undefined
            ? undefined
            : { account, disabled: runtime.visibilityStore.disabled(account) }
        },
        ...runtime.variant.id === CN_VARIANT.id ? {} : {
          // Presence of this field in the document is the card's capability
          // signal, so the getter answers `undefined` — not merely `false` —
          // on a host that cannot persist the preference.
          useMaximumContextWindow: () => legacySettingsAvailable
            ? current().useMaximumContextWindow === true
            : undefined,
        },
      })
      registerWorkBuddyProbeRoute(webCtx, {
        path: runtime.variant.probePath,
        probe: async modelId => {
          // The authenticated manual endpoint is called only after per-model confirmation.
          const result = await runtime.probeService.probe(modelId, true)
          if (result.state === 'ok') runtime.invalidate()
          return result
        },
        clear: () => { runtime.probeStore.clear(); runtime.invalidate() },
        refresh: async () => {
          if (stopped) return { state: 'failed', reason: 'plugin is stopping' }
          // Re-read the credential first: the user pressed this because the list
          // looks wrong, and a sign-in that happened since the last sweep is
          // the common cause.
          let credential
          try {
            credential = await runtime.store.current()
          } catch (error: unknown) {
            // A refused credential (wrong region, unreadable file) is a report,
            // not a crash out of the route.
            return {
              state: 'failed',
              reason: error instanceof Error ? error.message.slice(0, 300) : String(error),
            }
          }
          if (credential === undefined) {
            adoptIdentity(runtime, undefined, undefined)
            return { state: 'signed-out' }
          }
          const identity = credentialIdentity(credential)
          // Same transition the sweep performs: a switch reached through the
          // manual path must drop the previous account's data *now*.
          adoptIdentity(runtime, identity, visibilityAccountOf(credential))
          await fetchCatalog(runtime, identity)
          return runtime.catalogError === undefined
            ? { state: 'refreshed', reason: `${runtime.catalog.current().length} models` }
            : { state: 'failed', reason: runtime.catalogError }
        },
        ...runtime.variant.id === CN_VARIANT.id ? {} : {
          setMaximumContextWindow: async enabled => {
            if (setMaximumContextWindow === undefined) return { state: 'failed', reason: 'settings are unavailable' }
            return setMaximumContextWindow(enabled)
          },
        },
        setModelVisibility: async (modelId, visible, expectedAccount) => {
          // Refused rather than bucketed: a signed-out variant, or a credential
          // with no uid, has no account to key the preference by.
          const account = runtime.account()
          if (account === undefined) {
            return { state: 'failed', reason: 'model visibility needs a signed-in account with a stable user id' }
          }
          // Expected-account guard: the card names the account its checkboxes
          // were rendered from, so a stale card cannot land one account's
          // toggle in another account's bucket.
          if (expectedAccount !== account) {
            return { state: 'stale-account', reason: 'the signed-in account changed' }
          }
          try {
            runtime.visibilityStore.setVisible(account, modelId, visible)
          } catch (error: unknown) {
            // A toggle that did not persist must not be reported as saved.
            return { state: 'failed', reason: error instanceof Error ? error.message.slice(0, 300) : String(error) }
          }
          runtime.invalidate()
          return { state: 'updated' }
        },
        setComposerDisplay: async patch => {
          // The composer's chrome is machine-wide, not per account, so this
          // writes without an identity guard: switching accounts on the desktop
          // app should not resurrect a badge the user turned off.
          try {
            writeUiPreferences(patch)
          } catch (error: unknown) {
            // Reported as a failure rather than swallowed: a switch the user
            // pressed must not look saved when the file could not be written.
            return { state: 'failed', reason: error instanceof Error ? error.message.slice(0, 300) : String(error) }
          }
          // Every open composer reads this document; tell them it changed so the
          // annotation appears or disappears without a reload.
          ctx.emit('llm/adapters-updated')
          return { state: 'updated' }
        },
      }, probeKey)
    }

    // The check-in half's routes. Mounted here rather than in their own inject
    // so both halves share one webServer effect: the routes dispose together,
    // and a host without a webServer simply serves no browser panel while the
    // startup attempt still runs.
    registerBuddyCheckinRoutes(webCtx, { startup })
  })

  // Each settings section is what makes its namespace "served", which is how
  // `settings.yaml` and the TUI `/settings` read this plugin's fields.
  ctx.inject(['settings'], settingsCtx => {
    // Feature-detected through the structural type: a host carrying the
    // section API installs both legacy sections, while a newer host degrades to
    // a settings-less provider — provider, picker, visibility, and the context
    // rows all keep working.
    const legacy = legacySettingsOf(settingsCtx.settings)
    if (legacy === undefined) {
      ctx.logger.warn('dsh-buddy-suite: host settings service has no installSection API; per-variant settings and the maximum-context preference are unavailable')
      return
    }
    legacySettingsAvailable = true
    /** Section sources; each falls back to its own slice when its side unloads. */
    const sources: { cn: () => Config, ai: () => Config } = {
      cn: () => config,
      ai: () => config,
    }
    /** Merge both sections into the whole config the rest of the plugin reads. */
    const merged = (): Config => ({
      ...sources.cn().authFile === undefined ? {} : { authFile: sources.cn().authFile },
      ...sources.cn().probeConsent === undefined ? {} : { probeConsent: sources.cn().probeConsent },
      ...sources.ai().authFileAI === undefined ? {} : { authFileAI: sources.ai().authFileAI },
      ...sources.ai().useMaximumContextWindow === undefined ? {} : { useMaximumContextWindow: sources.ai().useMaximumContextWindow },
    })
    const applyMaximumContextWindow = (next: Config): void => {
      const runtime = runtimes.find(candidate => candidate.variant.id !== CN_VARIANT.id)
      if (runtime?.catalog.setUseMaximumContextWindow(next.useMaximumContextWindow === true)) runtime.invalidate()
    }
    const repointStores = (): void => {
      const next = merged()
      applyMaximumContextWindow(next)
      for (const runtime of runtimes) {
        runtime.store.setDesktopPath(configuredAuthFile(next, runtime.variant))
      }
    }
    legacy.installSection(ctx, WORKBUDDY_SETTINGS_NS, CN_SECTION, config, {
      setSource(source: () => Config) { sources.cn = source; current = merged },
      onChange: repointStores,
    })
    legacy.installSection(ctx, WORKBUDDY_AI_SETTINGS_NS, AI_SECTION, config, {
      setSource(source: () => Config) { sources.ai = source; current = merged },
      onChange: repointStores,
    })
    setMaximumContextWindow = async enabled => {
      await legacy.update(WORKBUDDY_AI_SETTINGS_NS, { useMaximumContextWindow: enabled })
      return { state: 'updated' }
    }
  })

  ctx.effect(() => () => {
    stopped = true
    for (const timer of timers) clearInterval(timer)
    timers.length = 0
    void clearHostHeartbeat()
  })

  /**
   * Fetch one variant's catalog for the current credential.
   *
   * Shared by the credential sweep and the card's manual refresh, and written
   * so that concurrent callers cost one request and cannot interleave badly:
   *
   * - **One request at a time.** A second caller joins the in-flight fetch.
   * - **Generation-checked write-back.** The request records the generation it
   *   started under and writes nothing if the generation moved on.
   * - **`resolve()`, not `current()`.** Only `resolve()` performs the locked,
   *   single-flight token renewal.
   */
  const fetchCatalog = async (runtime: VariantRuntime, identity: string): Promise<void> => {
    const inflight = runtime.inflightFetch
    const generation = runtime.catalogGeneration
    if (inflight !== undefined && inflight.identity === identity && inflight.generation === generation) {
      return inflight.promise
    }
    // A caller should normally reach this only after `adoptIdentity()` has
    // already cancelled a previous generation. Keep this guard local as well.
    inflight?.controller.abort()
    const controller = new AbortController()
    let run: Promise<void>
    run = (async (): Promise<void> => {
      let models: readonly WorkBuddyModelInfo[]
      try {
        const credential = await runtime.store.resolve()
        const resolvedIdentity = credentialIdentity(credential)
        // `current()` established the identity that owns this fetch, but
        // `resolve()` reads the desktop file again. The App can switch accounts
        // between those reads; never send or persist B's directory as A's.
        if (resolvedIdentity !== identity) {
          adoptIdentity(runtime, resolvedIdentity, visibilityAccountOf(credential))
          await fetchCatalog(runtime, resolvedIdentity)
          return
        }
        models = await runtime.client.fetchModels(credential, controller.signal)
        // The account can also change while the upstream request is in flight.
        const latest = await runtime.store.current()
        const latestIdentity = latest === undefined ? undefined : credentialIdentity(latest)
        if (latestIdentity !== identity) {
          adoptIdentity(runtime, latestIdentity, latest === undefined ? undefined : visibilityAccountOf(latest))
          if (latestIdentity !== undefined) await fetchCatalog(runtime, latestIdentity)
          return
        }
      } catch (error: unknown) {
        // Report only if this attempt is still the current one; a failure from
        // a superseded attempt must not overwrite the newer state's error.
        if (stopped || runtime.catalogGeneration !== generation) return
        runtime.lastFetchAtMs = Date.now()
        runtime.catalogError = error instanceof Error ? error.message.slice(0, 300) : String(error)
        ctx.logger.warn(
          `dsh-buddy-suite: ${runtime.variant.displayName} catalog unavailable; serving the fallback list`,
          error,
        )
        runtime.invalidate()
        return
      }
      if (stopped || runtime.catalogGeneration !== generation) return
      runtime.lastFetchAtMs = Date.now()
      runtime.catalog.set([...models])
      runtime.catalogSource = 'live'
      runtime.catalogFetchedAtMs = runtime.client.lastCatalog?.fetchedAtMs ?? Date.now()
      runtime.catalogError = undefined
      // Remember it for this account, so a restart — or a later fetch that
      // fails — can serve what this account was actually shown.
      if (lastIdentities.get(runtime.variant.id) === identity) {
        runtime.savedCatalogs.set(identity, {
          source: runtime.client.lastCatalog?.source ?? 'unknown',
          fetchedAtMs: runtime.client.lastCatalog?.fetchedAtMs ?? Date.now(),
          models: [...models],
          ...runtime.client.lastCatalog?.appVersion === undefined
            ? {}
            : { appVersion: runtime.client.lastCatalog.appVersion.version },
        })
      }
      runtime.invalidate()
    })().finally(() => {
      if (runtime.inflightFetch?.promise === run) runtime.inflightFetch = undefined
    })
    runtime.inflightFetch = { identity, generation, controller, promise: run }
    return run
  }

  /**
   * Reconcile one variant with its credentials.
   *
   * Four transitions matter, and each is a different action:
   *
   * - **none → some** (first sighting): reveal the group and fetch a catalog.
   * - **none → some, identity changed**: additionally drop the previous
   *   account's observations.
   * - **some → none**: hide the group and stop serving its models.
   * - **same identity**: nothing to do — the store refreshes tokens on demand.
   */
  const syncVariant = async (runtime: VariantRuntime): Promise<void> => {
    if (stopped || !runtime.registered) return
    const credential = await runtime.store.current().catch((error: unknown) => {
      // A region mismatch or an unreadable file is reported, not swallowed as
      // "signed out": the user needs to know which file to fix.
      ctx.logger.warn(`dsh-buddy-suite: ${runtime.variant.displayName} credential read failed`, error)
      return undefined
    })
    if (stopped) return

    if (credential === undefined) {
      adoptIdentity(runtime, undefined, undefined)
      return
    }

    const identity = credentialIdentity(credential)
    const known = lastIdentities.get(runtime.variant.id)
    if (known === identity && runtime.catalog.isVisible()) {
      // Same account, already showing something. One case still needs a fetch:
      // an earlier attempt failed, so the group is on the fallback roster and
      // nothing else will ever replace it. Retry on a slow backoff.
      const stale = runtime.catalogSource !== 'live'
      const due = Date.now() - runtime.lastFetchAtMs >= credentialPollMs() * CATALOG_RETRY_SWEEPS
      if (stale && due) await fetchCatalog(runtime, identity)
      return
    }

    adoptIdentity(runtime, identity, visibilityAccountOf(credential))
    await fetchCatalog(runtime, identity)
  }

  /** Run one reconcile sweep across both variants. */
  const syncAll = async (): Promise<void> => {
    for (const runtime of runtimes) await syncVariant(runtime)
  }

  /**
   * The check-in half's startup attempt.
   *
   * Created once per plugin instance and shared by every check-in route, so
   * the first panel open joins this run instead of starting a second one. A
   * failure is logged here and nowhere else: the panel then shows its own
   * query error rather than a silent empty state.
   */
  const startup = createBuddyCheckinStartup(ctx.logger)

  void Promise.all(runtimes.map(async runtime => startVariant(ctx, runtime))).then(() => {
    if (stopped) return
    // The host bundle is live: write a heartbeat so the status CLI can report
    // host health without a browser. Cleared on disposal.
    if (runtimes.some(runtime => runtime.registered)) void writeHostHeartbeat()

    void syncAll()
    const timer = setInterval(() => { void syncAll() }, credentialPollMs())
    timer.unref?.()
    timers.push(timer)
  })
}
