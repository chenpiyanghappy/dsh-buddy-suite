/**
 * Shared types for WorkBuddy's at-rest credential module.
 *
 * These describe the shapes the app writes (`$wbEncrypted` field wrappers), the
 * values the key helper returns, and the option bags the decryption and
 * discovery layers accept. Kept free of runtime imports so both layers can name
 * them without pulling each other in.
 *
 * The product profiles are re-exported from `variants.ts` below, so a caller
 * that only needs decryption has one import site for the types it names.
 *
 * @module dsh-buddy-suite/credential/types
 */

import type { WorkBuddyElectronProduct } from '../variants.ts'

/**
 * The product profiles and the CN env var are declared in `variants.ts` and
 * re-exported here so callers that only need decryption have one import site.
 * The type is re-exported too, because every signature below names it.
 */
export {
  AI_ELECTRON_PROFILE,
  CN_ELECTRON_PROFILE,
  WORKBUDDY_ELECTRON_BIN_ENV,
} from '../variants.ts'
export type { WorkBuddyElectronProduct } from '../variants.ts'

/** The four states a desktop auth document can be read as. */
export type DesktopAuthFormat = 'absent' | 'plaintext' | 'encrypted' | 'unrecognized'

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

/** The validated `loggerGet()` payload: the sealed at-rest secret. */
export interface WorkBuddyAtRestPayload {
  atRestSecretKey: string
}

/** A resolved protector key and the id envelopes name for it. */
export interface ProtectorKey {
  key: Buffer
  keyId: string
}

/** Where the raw `loggerGet()` payload text comes from; tests stand one in. */
export type KeySource = () => Promise<string>

/** Registry query seam so tests never spawn reg.exe. */
export type RegistryRootQuery = (root: string, signal: AbortSignal) => Promise<string>

/** Electron resolution options. */
export interface ElectronResolutionOptions {
  registry?: RegistryRootQuery
  discoveryBudgetMs?: number
  /** Which product's Electron to resolve; defaults to the CN profile. */
  product?: WorkBuddyElectronProduct
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

/** Seams the discovery flow runs through, so tests never spawn a process. */
export interface WorkBuddyDiscoveryTools {
  findApps: (signal: AbortSignal) => Promise<readonly string[]>
  bundleIdentifier: (bundlePath: string, signal: AbortSignal) => Promise<string | undefined>
  bundleVersion: (bundlePath: string, signal: AbortSignal) => Promise<string | undefined>
}

/**
 * Which automatic discovery, if any, a provider may run when no explicit
 * binary is configured. The value says which *platform* may be searched,
 * never which product: two products on the same platform are told apart by
 * the product profile.
 */
export type WorkBuddyElectronDiscovery = 'none' | 'macos-workbuddy' | 'windows-workbuddy'

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
