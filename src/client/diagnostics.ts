/**
 * The diagnostics bundle: everything needed to explain a report, and nothing
 * that could be used to act as the user.
 *
 * Built from the status document the card already holds, so exporting costs no
 * upstream request and no extra host surface. Two things are removed on the way
 * out:
 *
 * - `probeKey` — an in-process secret that authorizes credit-spending writes for
 *   the life of the process. A diagnostics blob gets pasted into issues, chats,
 *   and agent sessions, which is exactly the wrong place for a bearer secret.
 * - the per-package credit ledger — measured at 49 entries on one real account,
 *   which buries the part of the report a reader actually needs. The totals and
 *   the expiry buckets are kept, and so is the row count; the row contents are
 *   not.
 *
 * @module dsh-buddy-suite/client/diagnostics
 */

import type { WorkBuddyWebCreditExpiry, WorkBuddyWebStatus } from '../status-paths.ts'

/** What the bundle carries besides the status document. */
export interface DiagnosticsIdentity {
  /** Plugin package name, so a reader knows which project to look at. */
  packageName: string
  /** Provider id (`workbuddy-suite` / `workbuddy-ai-suite`). */
  provider: string
  /** Collection time, ISO 8601. */
  generatedAt: string
  /**
   * Plugin version.
   *
   * Not optional in practice: a report that does not say which release produced
   * it cannot be matched against a fix, which is the first thing a maintainer
   * asks. The field stays optional only so a caller that genuinely has no
   * version can still build a bundle.
   */
  version?: string
}

/** The credit summary the bundle keeps: totals and shape, not the ledger. */
export interface DiagnosticsCredits {
  total: number
  unlimited?: true
  cycleResetTime?: string
  expiry?: WorkBuddyWebCreditExpiry
  /** How many packages the account holds, so a reader can tell big from small. */
  accountCount: number
}

/** The status document as the bundle carries it. */
export type DiagnosticsStatus =
  | Exclude<WorkBuddyWebStatus, { status: 'signed-in' }>
  | (Omit<Extract<WorkBuddyWebStatus, { status: 'signed-in' }>, 'probeKey' | 'credits'> & {
    credits?: DiagnosticsCredits
  })

/** The exported document. */
export interface DiagnosticsBundle extends DiagnosticsIdentity {
  /** The status document with every secret removed. */
  status: DiagnosticsStatus
}

/** Collapse the credit ledger to the facts a report needs. */
function slimCredits(
  credits: Extract<WorkBuddyWebStatus, { status: 'signed-in' }>['credits'],
): DiagnosticsCredits | undefined {
  if (credits === undefined) return undefined
  const { accounts, ...rest } = credits
  return { ...rest, accountCount: accounts.length }
}

/**
 * Strip the control key and slim the ledger.
 *
 * The key is removed rather than masked: a mask leaves a reader wondering
 * whether the real value leaked elsewhere.
 */
function withoutSecrets(status: WorkBuddyWebStatus): DiagnosticsStatus {
  if (status.status !== 'signed-in') return status
  const { probeKey: _probeKey, credits, ...rest } = status
  const slimmed = slimCredits(credits)
  return {
    ...rest,
    ...slimmed === undefined ? {} : { credits: slimmed },
  }
}

/**
 * Build the bundle a user can paste into a report.
 *
 * `generatedAt` is injected rather than read from the clock so the output is
 * reproducible in tests.
 */
export function buildDiagnosticsBundle(
  status: WorkBuddyWebStatus,
  identity: { packageName: string, provider: string, version?: string },
  generatedAt: string,
): DiagnosticsBundle {
  return {
    packageName: identity.packageName,
    provider: identity.provider,
    generatedAt,
    ...identity.version === undefined ? {} : { version: identity.version },
    status: withoutSecrets(status),
  }
}

/**
 * Whether a bundle is worth exporting at all.
 *
 * A card that has not managed to read the document yet has nothing to report,
 * and copying an empty shell wastes the user's paste.
 */
export function hasDiagnosableState(status: WorkBuddyWebStatus | undefined): boolean {
  if (status === undefined) return false
  if (status.status === 'error') return true
  if (status.status === 'signed-out') return status.reason !== undefined || status.reasonCode !== undefined
  return true
}
