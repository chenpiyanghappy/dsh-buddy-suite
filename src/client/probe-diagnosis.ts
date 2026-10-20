/**
 * Readable diagnoses for failed detections.
 *
 * A failed probe records the failing stage, the HTTP status, and the upstream's
 * own error code and message. That is the right data to keep — it is what makes
 * a report actionable — but it is not what a user can act on: the CN endpoint
 * answers `1210` for several unrelated causes, and the international one answers
 * `invalid_parameter_value` with prose that names no field at all.
 *
 * This module turns that record into one short sentence naming the most likely
 * cause and, implicitly, what to do about it. It never changes a capability
 * claim: a diagnosis explains why a detection could not complete, and the model
 * still stays undetected. Everything it cannot recognize falls back to the raw
 * text rather than to a guess.
 *
 * The patterns are measurements of strings this plugin parsed itself, not of a
 * stable protocol, so they are ordered from the most specific to the least and
 * any unknown shape simply does not match.
 *
 * @module dsh-buddy-suite/client/probe-diagnosis
 */

import type { WorkBuddySettingsKey } from './locales.ts'

/** A translated, short enough to sit in a chip, explanation of a failure. */
export type ProbeDiagnosis = WorkBuddySettingsKey

/**
 * Recognized failure shapes, most specific first.
 *
 * `match` reads the recorded reason, which is produced by `unknownReason` in the
 * probe and has the shape `<stage> status <status> (<code>): <detail>`, possibly
 * followed by `; retry at max_tokens <n>: <stage> status ...`.
 */
const PATTERNS: readonly { pattern: RegExp, key: ProbeDiagnosis }[] = [
  // The request never reached the upstream, or the connection died mid-flight.
  { pattern: /transport error|status 0\b/iu, key: 'probeDiagTransport' },
  // Credential problems: the request was understood and refused.
  { pattern: /status (?:401|403)\b/iu, key: 'probeDiagAuth' },
  { pattern: /status 429\b/iu, key: 'probeDiagRateLimit' },
  // 5xx is the upstream failing, not the request being wrong.
  { pattern: /status 5\d{2}\b/iu, key: 'probeDiagServer' },
  // A model the endpoint does not know: the catalog is ahead of the roster.
  { pattern: /11102|unknown model/iu, key: 'probeDiagUnknownModel' },
  // The output ceiling sits below the model's floor.
  { pattern: /11133[\s\S]*integer_below_min_value|integer_below_min_value/iu, key: 'probeDiagMaxTokens' },
  // The upstream refuses the effort value itself. The CN endpoint reuses the
  // generic 1210 code for this, so the message is what identifies it.
  { pattern: /reasoning[ _-]?effort[^.]*not supported/iu, key: 'probeDiagEffortRejected' },
  { pattern: /invalid_reasoning_effort|invalid_parameter_value/iu, key: 'probeDiagEffortRejected' },
  // A generic parameter rejection with no further detail.
  { pattern: /\b1210\b/iu, key: 'probeDiagParameter' },
]

/**
 * Explain a recorded detection failure, or `undefined` when it is not one.
 *
 * Returns a locale key rather than a sentence so the caller keeps the user's
 * language, and returns `undefined` for an absent or unrecognized reason so the
 * caller can show the raw text instead of inventing a cause.
 */
export function diagnoseProbeReason(reason: string | undefined): ProbeDiagnosis | undefined {
  if (reason === undefined || reason.trim() === '') return undefined
  for (const { pattern, key } of PATTERNS) {
    if (pattern.test(reason)) return key
  }
  return undefined
}
