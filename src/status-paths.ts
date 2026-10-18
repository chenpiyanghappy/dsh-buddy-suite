/**
 * Node-free constants and types shared by the Host and browser halves.
 *
 * Everything the browser bundle needs about routes, shapes, and vocabularies
 * lives here so neither half can drift from the other: the two bundles build
 * independently, and a shared expression is one build-config change away from
 * one side asking a route the other never mounted.
 *
 * @module dsh-buddy-suite/status-paths
 */

/** Plugin-owned status endpoint consumed by the CN variant's browser card. */
export const WORKBUDDY_STATUS_PATH = '/plugins/dsh-buddy-suite/status'

/**
 * Plugin-owned probe control endpoint.
 *
 * Separate from the status route because it accepts writes: the status route's
 * loopback Host/Origin guard protects against a DNS-rebinding *page*, which is
 * not the same as authorizing a state-changing action. This route therefore
 * also requires the in-process key the browser half receives with the status
 * document.
 */
export const WORKBUDDY_PROBE_PATH = '/plugins/dsh-buddy-suite/probe'

/** The international variant's own pair of routes. */
export const WORKBUDDY_AI_STATUS_PATH = '/plugins/dsh-buddy-suite/ai/status'
export const WORKBUDDY_AI_PROBE_PATH = '/plugins/dsh-buddy-suite/ai/probe'

/** Same-origin route backing the browser's update reminder. */
export const WORKBUDDY_UPDATE_PATH = '/plugins/dsh-buddy-suite/update'

/**
 * The check-in half's status route.
 *
 * Separate from the provider's routes because it answers for *every* account
 * on the machine, not one signed-in credential, and because it carries a
 * write: `POST` retries the accounts that failed today. It is read-only apart
 * from that, and the loopback gate is the same one the provider's routes use.
 */
export const BUDDY_CHECKIN_PATH = '/plugins/dsh-buddy-suite/checkin'

/**
 * The check-in half's balance-refresh route.
 *
 * Opening the details panel is the lazy day-rollover trigger, so this route
 * does two things: it signs today's day if the process has been running
 * across midnight, then re-reads every account's balance. Kept apart from
 * {@link BUDDY_CHECKIN_PATH} so a plain status read never mutates.
 */
export const BUDDY_CHECKIN_BALANCE_PATH = '/plugins/dsh-buddy-suite/checkin/balance'

/** One model's recorded probe observation, as the card displays it. */
export interface WorkBuddyWebProbeModel {
  id: string
  name: string
  /** `validating` results carry efforts; the other states never do. */
  validation: 'validating' | 'non-validating' | 'unknown'
  efforts: readonly string[]
  probedAt: number
}

/** Probe section of the status document. */
export interface WorkBuddyWebProbeSection {
  /** Whether the user has authorized probing. */
  consent: boolean
  /** Whether a sweep is in flight right now. */
  running: boolean
  /** Models the user could probe by hand (undeclared yet reasoning-capable). */
  candidates: readonly string[]
  /** Recorded observations. */
  results: readonly WorkBuddyWebProbeModel[]
}

/** Action requested from the probe control route. */
export interface WorkBuddyProbeAction {
  /**
   * `probe` spends credit on one model; `clear` drops recorded observations;
   * `refresh` re-reads the credential and re-fetches the model catalog;
   * `set-maximum-context-window` persists the international card preference;
   * `set-model-visibility` hides or shows one model for the signed-in account;
   * `set-composer-display` toggles the composer's credit badge or
   * reasoning-level entry.
   */
  action: 'probe' | 'clear' | 'refresh' | 'set-maximum-context-window' | 'set-model-visibility' | 'set-composer-display'
  /** Target model id; required for `probe` and `set-model-visibility`. */
  model?: string
  /** Requested value for `set-maximum-context-window` and `set-model-visibility`. */
  enabled?: boolean
  /** Requested picker visibility for `set-model-visibility`. */
  visible?: boolean
  /**
   * Expected account key for `set-model-visibility`: the `visibility.account`
   * the card rendered its checkboxes from. The host refuses the write when the
   * signed-in account has moved on.
   */
  account?: string
  /** Requested credit-badge visibility for `set-composer-display`. */
  showCreditBadge?: boolean
  /** Requested reasoning-level visibility for `set-composer-display`. */
  showReasoningLevels?: boolean
}

/**
 * Model-visibility section of the status document.
 *
 * Present only when an account with a stable user id is signed in: the
 * preferences are per account, so a credential without a uid has nothing to
 * key them by and the card renders no visibility controls rather than editing
 * a bucket every uid-less account would share.
 */
export interface WorkBuddyWebVisibilitySection {
  /** The `uid:enterpriseId` identity these preferences belong to. */
  account: string
  /** Model ids this account has hidden from the picker. */
  disabled: readonly string[]
}

/**
 * Where the models a card is currently showing came from.
 */
export interface WorkBuddyWebCatalog {
  /**
   * `live` (fetched now) → `saved` (this account's last successful fetch) →
   * `fallback` (the roster compiled into the plugin).
   */
  source: 'live' | 'saved' | 'fallback'
  /** When the live catalog last succeeded, epoch ms. */
  fetchedAt?: number
  /** App version used as the catalog User-Agent, when the variant needed one. */
  appVersion?: string
  /** Why the most recent fetch failed, when it did, redacted for display. */
  error?: string
}

/** One billing package and its remaining credit. */
export interface WorkBuddyWebCreditAccount {
  packageName: string
  remain: number
  size: number
  unlimited?: true
  /** When the package lapses, in epoch milliseconds; absent when unknown. */
  endTimeMs?: number
}

/** Credit lapsing inside one horizon, as the card reports it. */
export interface WorkBuddyWebExpiringCredits {
  total: number
  packages: number
  earliestEndTimeMs?: number
}

/**
 * Credit at risk, bucketed by horizon.
 *
 * Only present when the upstream actually reported end times — a card must not
 * read "no expiry data" as "nothing expires soon".
 */
export interface WorkBuddyWebCreditExpiry {
  within24h: WorkBuddyWebExpiringCredits
  within3d: WorkBuddyWebExpiringCredits
  within7d: WorkBuddyWebExpiringCredits
}

/** Aggregated credit answer rendered by the plugin card. */
export interface WorkBuddyWebCredits {
  total: number
  accounts: readonly WorkBuddyWebCreditAccount[]
  unlimited?: true
  cycleResetTime?: string
  /** Credit lapsing soon, for the card's warning banner. */
  expiry?: WorkBuddyWebCreditExpiry
}

/** Billing convenience facts for one model, rendered as card badges. */
export interface WorkBuddyWebModelBadge {
  id: string
  name: string
  free?: boolean
  badges?: readonly string[]
  credits?: string
  rateUnknown?: true
  /**
   * Effort levels the *catalog* declares for this model, when it declares any.
   *
   * Carried so the probe panel can say what a model will actually use when a
   * detection concludes its effort parameter is not checked. A model that
   * ignores `reasoning_effort` still runs at some level, and the catalog row
   * names it — reporting "not adjustable" without that level leaves the reader
   * unable to tell what the model is doing instead.
   */
  declaredEfforts?: readonly string[]
  /** The effort the upstream uses when none is chosen, when it declares one. */
  defaultEffort?: string
  contextWindow?: number
  defaultContextWindow?: number
  maxContextWindow?: number
  maxInputTokens?: number
}

/**
 * Why no credential is usable, as a closed enum the browser half switches on.
 *
 * Deliberately separate from `reason`: `reason` is free text meant for a human,
 * so matching on it would break the moment the wording changes.
 */
export type WorkBuddySignedOutReasonCode =
  /** Nobody is signed in; nothing diagnosable beyond that. */
  | 'no-credential'
  /** A credential for the *other* product was found in this variant's file. */
  | 'credential-region-mismatch'
  /** An encrypted credential exists but could not be opened. */
  | 'encrypted-credential-unreadable'
  /** A product on a supported platform: discovery found no usable candidate. */
  | 'electron-binary-not-found'
  /** A product on a supported platform: discovery found more than one app. */
  | 'electron-binary-ambiguous'
  /** No auto-discovery for this product/platform and no explicit path. */
  | 'electron-binary-unavailable'
  /** An explicit path (option or env) is set but missing or not executable. */
  | 'electron-path-invalid'
  /** Discovery could not finish: tool missing, timeout, output overflow. */
  | 'electron-discovery-incomplete'

/** Every reason code, for validation without trusting a wire value. */
const SIGNED_OUT_REASON_CODES: readonly WorkBuddySignedOutReasonCode[] = [
  'no-credential',
  'credential-region-mismatch',
  'encrypted-credential-unreadable',
  'electron-binary-not-found',
  'electron-binary-ambiguous',
  'electron-binary-unavailable',
  'electron-path-invalid',
  'electron-discovery-incomplete',
]

/** Whether a value is one of the closed set of signed-out reason codes. */
export function isWorkBuddySignedOutReasonCode(value: unknown): value is WorkBuddySignedOutReasonCode {
  return typeof value === 'string' && (SIGNED_OUT_REASON_CODES as readonly string[]).includes(value)
}

/** The JSON document the provider card renders. */
export type WorkBuddyWebStatus =
  | {
    status: 'signed-out'
    reason?: string
    reasonCode?: WorkBuddySignedOutReasonCode
  }
  | {
    status: 'signed-in'
    nickname?: string
    domain?: string
    source?: 'desktop' | 'dsh'
    expiresAt?: number
    credits?: WorkBuddyWebCredits
    creditsError?: string
    models?: readonly WorkBuddyWebModelBadge[]
    catalog?: WorkBuddyWebCatalog
    probe?: WorkBuddyWebProbeSection
    useMaximumContextWindow?: boolean
    visibility?: WorkBuddyWebVisibilitySection
    probeKey?: string
    /**
     * Which composer annotations this plugin should render.
     *
     * Read by the composer control, which owns the credit badge and the
     * reasoning-level entry. Absent on a host that predates the switch, in
     * which case the control shows both — the pre-switch behaviour.
     */
    ui?: WorkBuddyWebUiPreferences
  }
  | { status: 'error'; message: string }

/**
 * Composer-chrome visibility, as the browser half reads it.
 *
 * Mirrors `ui-preferences.ts` without importing it: that module reads and
 * writes files, and the browser bundle must stay free of Node built-ins.
 */
export interface WorkBuddyWebUiPreferences {
  /** Render the account's remaining credit beside the composer. */
  showCreditBadge: boolean
  /** Render the reasoning-level entry beside the composer. */
  showReasoningLevels: boolean
}

/**
 * One account's check-in outcome, as the details panel displays it.
 *
 * Node-free so the browser half and the host half agree on the shape without
 * either importing the other.
 */
export interface BuddyCheckinRow {
  /** The account's stable user id; never a token. */
  uid: string
  /** Display name when the credential carried one (encrypted ones may not). */
  nickname?: string
  /** `signed` claimed today's credit; `already` found it claimed; `failed` could not. */
  state: 'signed' | 'already' | 'failed'
  /** When this row was produced, epoch ms. */
  at: number
  /** Credit the check-in granted, when the answer carried one. */
  credit?: number
  /** Latest remaining credit, from a balance read. */
  balance?: number
  /** When {@link balance} was read, epoch ms. */
  balanceCheckedAt?: number
  /** Why the balance could not be read; the last known figure stays on screen. */
  balanceError?: string
  /** Why the check-in itself failed. */
  error?: string
}

/**
 * The check-in status document the panel renders.
 *
 * `day` is the calendar day (Asia/Shanghai) the results belong to: the panel
 * compares it against today to decide whether a long-lived process still owes
 * the current day's attempt.
 */
export interface BuddyCheckinDocument {
  /** Calendar day in `YYYY-MM-DD`, Asia/Shanghai. */
  day: string
  /** When the last check-in attempt ran, epoch ms. */
  checkedAt: number
  /** When balances were last refreshed, epoch ms. */
  balanceCheckedAt?: number
  /** One-shot startup summary, claimed by its first reader. */
  notice?: string
  /** Per-account results, one row per account found on this machine. */
  results: readonly BuddyCheckinRow[]
  /**
   * Roll-up state: `none` (no CN accounts at all), `ok` (all signed or
   * already), `warn` (at least one failed), `error` (everything failed).
   */
  status: 'none' | 'ok' | 'warn' | 'error'
}
