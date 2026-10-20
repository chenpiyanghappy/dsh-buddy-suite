/**
 * The two WorkBuddy desktop apps this plugin serves.
 *
 * Both products are the same client framework in different regions, and both
 * write their sign-in into the *same* shared `CodeBuddyExtension` auth
 * directory — they differ by file basename, base URL, catalog endpoint, and
 * display identity. Everything that varies between them is collected here as
 * one descriptor, so no module has to carry its own `if (international)`
 * branch and a third variant would be a data change rather than a refactor.
 *
 * The check-in half of the bundle is CN-only by measurement (the daily
 * check-in endpoint answers an international token with 401), so it reads
 * {@link CN_VARIANT} and ignores the rest.
 *
 * This module is host-side (it names files and env vars). The browser half
 * takes the same ids and routes from the Node-free `status-paths.ts`, which
 * stays the single source shared by both halves.
 *
 * @module dsh-buddy-suite/variants
 */

import {
  WORKBUDDY_AI_STATUS_PATH,
  WORKBUDDY_AI_PROBE_PATH,
  WORKBUDDY_PROBE_PATH,
  WORKBUDDY_STATUS_PATH,
} from './status-paths.ts'
import type { WorkBuddyRegion } from './upstream.ts'

/**
 * Env variable naming an explicit Electron binary for the CN product. The
 * international product has its own
 * ({@link WorkBuddyElectronProduct.envVar}); a shared variable is a single
 * point of failure across two independently installed apps.
 */
export const WORKBUDDY_ELECTRON_BIN_ENV = 'WORKBUDDY_ELECTRON_BIN'

/**
 * How one product's Electron key helper is identified on each platform, and
 * which env var names an explicit binary for it.
 *
 * The profile is the *only* place product identity enters helper resolution —
 * never the discovery setting, which only says whether a platform may be
 * searched at all: two products on the same platform differ by bundle id /
 * registry name / exe basename, so a discovery that matches one can never
 * legitimately execute the other's binary.
 */
export interface WorkBuddyElectronProduct {
  /** Product name for helper diagnostics and error copy, e.g. `WorkBuddy AI`. */
  productName: string
  /** Env var naming an explicit Electron binary for this product alone. */
  envVar: string
  /** macOS identity and default install layout, verified per product. */
  macOS: {
    bundleId: string
    defaultPath: string
  }
  /**
   * Windows identity from the uninstall registry and the exe it names.
   * `defaultPathSegments` exists only where the default install location has
   * been measured; an unverified default is a guess, and guessing is how the
   * wrong app gets executed.
   */
  windows: {
    displayNamePattern: RegExp
    exeBasename: string
    defaultPathSegments?: readonly string[]
  }
}

/**
 * The CN product's Electron profile: the only one with a verified Windows
 * default install location.
 */
export const CN_ELECTRON_PROFILE: WorkBuddyElectronProduct = {
  productName: 'WorkBuddy',
  envVar: WORKBUDDY_ELECTRON_BIN_ENV,
  macOS: {
    bundleId: 'com.tencent.workbuddy.mac',
    defaultPath: '/Applications/WorkBuddy.app/Contents/MacOS/Electron',
  },
  windows: {
    displayNamePattern: /^WorkBuddy(?:\s+\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)?$/u,
    exeBasename: 'workbuddy.exe',
    defaultPathSegments: ['Programs', 'WorkBuddy', 'WorkBuddy.exe'],
  },
}

/**
 * The international product's Electron profile; registry-only on Windows,
 * because that app has only ever been seen in user-chosen locations.
 */
export const AI_ELECTRON_PROFILE: WorkBuddyElectronProduct = {
  productName: 'WorkBuddy AI',
  envVar: 'WORKBUDDY_AI_ELECTRON_BIN',
  macOS: {
    bundleId: 'com.workbuddy.workbuddy-ai',
    defaultPath: '/Applications/WorkBuddy AI.app/Contents/MacOS/Electron',
  },
  windows: {
    // Measured against a real record: `WorkBuddy AI 5.6.2`. The CN pattern
    // cannot match this value ("AI" is not a version) and this pattern cannot
    // match `WorkBuddy 5.6.2` (missing the literal " AI"), so the two records
    // never feed each other's discovery.
    displayNamePattern: /^WorkBuddy AI(?:\s+\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)?$/u,
    exeBasename: 'workbuddyai.exe',
  },
}

/** One WorkBuddy product variant. */
export interface WorkBuddyVariant {
  /** Provider id registered with DSH, e.g. `workbuddy-ai`. */
  id: string
  /** Model-group heading and card title stem, e.g. `WorkBuddy AI`. */
  displayName: string
  /** Desktop app name as users know it, for diagnostics and error copy. */
  appName: string
  /** Which upstream region this variant's credentials must belong to. */
  region: WorkBuddyRegion
  /** Env var overriding the desktop auth-file location. */
  env: string
  /**
   * How this product's Electron helper is identified and located.
   *
   * Optional for source compatibility: `WorkBuddyVariant` is a public type and
   * existing callers construct their own descriptors without it. Resolution
   * falls back to {@link electronProfileFor}, keyed by variant id.
   */
  electron?: WorkBuddyElectronProduct
  /** Basename of the desktop app's own auth file in the shared auth directory. */
  desktopFilename: string
  /** Basename of the plugin-owned credential copy under `$DSH_HOME`. */
  ownFilename: string
  /** Basename of the plugin-owned probe-record file under `$DSH_HOME`. */
  probeFilename: string
  /** Basename of the plugin-owned saved-catalog file under `$DSH_HOME`. */
  catalogFilename: string
  /** Basename of the plugin-owned per-account model-visibility file under `$DSH_HOME`. */
  visibilityFilename: string
  /** Same-origin status route consumed by this variant's card. */
  statusPath: string
  /** Same-origin probe-control route consumed by this variant's card. */
  probePath: string
}

/**
 * CN WorkBuddy first.
 *
 * The ids are namespaced to this bundle rather than reusing the bare
 * `workbuddy` / `workbuddy-ai` that dsh-workbuddy-connect registers. A provider
 * id is a key the host's model registry holds once, so two bundles claiming the
 * same id means one silently replaces the other — installing both made the
 * model group and its cards flip depending on load order. A distinct pair lets
 * the two plugins coexist: the picker shows this bundle's group beside the
 * other's, and a profile that pins `workbuddy/<model>` as its default keeps
 * working because the other plugin still owns that id.
 *
 * Display names stay "WorkBuddy" and "WorkBuddy AI": the ids are internal, the
 * names are what the user reads.
 */
export const WORKBUDDY_VARIANTS: readonly WorkBuddyVariant[] = [
  {
    id: 'workbuddy-suite',
    displayName: 'WorkBuddy',
    appName: 'WorkBuddy',
    region: 'cn',
    env: 'WORKBUDDY_AUTH_FILE',
    electron: CN_ELECTRON_PROFILE,
    desktopFilename: 'workbuddy-desktop.info',
    ownFilename: '.workbuddy-auth.json',
    probeFilename: '.buddy-suite-probe.json',
    catalogFilename: '.workbuddy-catalog.json',
    visibilityFilename: '.workbuddy-model-visibility.json',
    statusPath: WORKBUDDY_STATUS_PATH,
    probePath: WORKBUDDY_PROBE_PATH,
  },
  {
    id: 'workbuddy-ai-suite',
    displayName: 'WorkBuddy AI',
    appName: 'WorkBuddy AI',
    region: 'global',
    env: 'WORKBUDDY_AI_AUTH_FILE',
    electron: AI_ELECTRON_PROFILE,
    desktopFilename: 'workbuddy-desktop-ai.info',
    ownFilename: '.workbuddy-ai-auth.json',
    probeFilename: '.buddy-suite-ai-probe.json',
    catalogFilename: '.workbuddy-ai-catalog.json',
    visibilityFilename: '.workbuddy-ai-model-visibility.json',
    statusPath: WORKBUDDY_AI_STATUS_PATH,
    probePath: WORKBUDDY_AI_PROBE_PATH,
  },
]

/** The CN variant; the plugin's long-standing default and compatibility anchor. */
export const CN_VARIANT = WORKBUDDY_VARIANTS[0]! satisfies WorkBuddyVariant

/** The international variant. */
export const AI_VARIANT = WORKBUDDY_VARIANTS[1]! satisfies WorkBuddyVariant

/** Look up a variant by provider id. */
export function variantFor(id: string): WorkBuddyVariant | undefined {
  return WORKBUDDY_VARIANTS.find(variant => variant.id === id)
}

/**
 * The Electron profile a variant resolves with.
 *
 * Callers inside the plugin pass their known-complete variants; descriptors
 * assembled outside fall back by variant id, so an id-less or unknown custom
 * variant stays on the CN product.
 */
export function electronProfileFor(
  variant: Pick<WorkBuddyVariant, 'id' | 'electron'> | undefined,
): WorkBuddyElectronProduct {
  return variant?.electron ?? (variant?.id === AI_VARIANT.id ? AI_VARIANT : CN_VARIANT).electron!
}
