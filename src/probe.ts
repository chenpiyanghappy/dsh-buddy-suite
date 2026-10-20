/**
 * The reasoning-effort probe: decide whether a model's `reasoning_effort`
 * parameter is actually validated, and if so which canonical values it accepts.
 *
 * Implements `docs/reasoning-effort-probe-plan.md` §4. The order matters and is
 * not an optimization:
 *
 * 1. **Baseline** (no `reasoning_effort`) proves the model, credential, and
 *    request shape work at all, so a later rejection can be attributed.
 * 2. **Sentinel** (a fresh random, impossible-to-collide value) answers the one
 *    question a per-level sweep cannot: does the upstream validate the field?
 *    A model that accepts the sentinel answers 200 to *everything*, so its
 *    per-level results would be uniformly false positives.
 * 3. **Levels**, only after the sentinel was refused.
 *
 * The result is an observation, never a capability claim. Even a fully
 * successful sweep means "the upstream accepted these spellings", not "these
 * spellings change how the model thinks".
 *
 * @module dsh-buddy-suite/probe
 */

import { randomBytes } from 'node:crypto'
import type { WorkBuddyEffort } from './upstream.ts'

/**
 * The canonical values a probe tests, in a fixed order.
 *
 * `minimal` is absent: it appears in no upstream vocabulary. `off` is absent
 * by policy — disabling thinking is a separate capability the upstream must
 * declare through `canDisableThinking`, never something probing may infer.
 */
export const PROBE_EFFORT_CANDIDATES: readonly WorkBuddyEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** Prompt body used by every probe request; carries nothing user-specific. */
export const PROBE_PROMPT = 'ping'

/** Output ceiling for a probe request; the answer itself is never read. */
export const PROBE_MAX_TOKENS = 1

/**
 * Ceiling for the one retry a rejected baseline gets.
 *
 * `max_tokens: 1` is the smallest value the field can carry, and some models
 * refuse it outright: the CN endpoint answers a bare parameter error (measured
 * on `glm-5.1`, `400` / `1210`) while the international GPT-5.6 family answers
 * `11133` `integer_below_min_value`. That rejection is a fact about the
 * *request*, never about the model's effort support, so the baseline — the one
 * attempt that carries no effort at all — retries once at a floor that clears
 * the observed minimums while staying far too small to produce a real answer.
 *
 * Only the baseline retries. The sentinel and level attempts keep the small
 * ceiling so a genuine effort rejection is still answered in one request and
 * the sweep cannot silently double in cost.
 */
export const PROBE_BASELINE_RETRY_MAX_TOKENS = 16

/** Per-request ceiling so one hung probe cannot stall the queue. */
export const PROBE_REQUEST_TIMEOUT_MS = 30_000

/** Sentinel generator; injectable so tests get deterministic values. */
export type SentinelFactory = () => string

/** Default sentinel: unmistakably non-canonical, different on every call. */
export function randomSentinel(): string {
  return `probe_sentinel_${randomBytes(12).toString('hex')}`
}

/**
 * One response as the probe sees it, split into the only distinctions the
 * attribution rule needs.
 */
export interface ProbeAttempt {
  /** HTTP status, or 0 for a transport failure. */
  status: number
  /** True when a parseable SSE event arrived. */
  streamed: boolean
  /** `extError.code` from a JSON error body, when present. */
  errorCode?: string
  /**
   * The upstream's own message text, when the body carried one.
   *
   * Needed because a code is not always specific enough to attribute: the CN
   * endpoint answers `1210` both for an unsupported `reasoning_effort` *and*
   * for an absent one, and only its message distinguishes the two.
   */
  errorMessage?: string
  /** Free-form detail for logs; never shown as a capability claim. */
  detail?: string
}

/**
 * How one attempt is performed; the caller owns credentials and HTTP.
 *
 * `maxTokens` overrides the request's output ceiling for that one attempt. Only
 * the baseline's floor retry passes one; every other attempt leaves it
 * `undefined` and the sender applies its own default.
 */
export type ProbeSender = (effort: string | undefined, signal: AbortSignal, maxTokens?: number) => Promise<ProbeAttempt>

/** The outcome of probing one model. */
export type ProbeOutcome =
  | { validation: 'validating'; efforts: readonly WorkBuddyEffort[]; requests: number }
  | { validation: 'non-validating'; efforts: readonly []; requests: number }
  | { validation: 'unknown'; efforts: readonly []; requests: number; reason: string }

/** Which endpoint's rejection vocabulary a probe interprets. */
export type ProbeRegion = 'cn' | 'global'

/**
 * The upstream's "this effort value is not supported" codes, per region, as
 * measured on each live endpoint. The sets are kept separate so a code only
 * ever widens detection for the endpoint it was measured on.
 *
 * - `invalid_reasoning_effort` — the China endpoint, measured 2026-09-11
 *   (plan §4.2). Also kept for `global` as a fallback spelling.
 * - `model_param_invalid` — the global endpoint, measured 2026-10-01. A
 *   non-canonical value is answered `400` / `11133` with this code, which names
 *   no field (`extError.param` is empty), instead of one that names the effort.
 *   It is generic enough to be readable here only because the baseline step has
 *   already proved the *same* request without `reasoning_effort` succeeds,
 *   leaving the sentinel as the only difference between the two attempts. A
 *   sibling code in the same `11133` envelope that names another parameter
 *   (`integer_below_min_value`, the `max_tokens` floor) and a body carrying no
 *   `extError` at all (`11102`, unknown model) are therefore not mistaken for
 *   it, and neither is a level-sweep answer.
 * - `invalid_parameter_value` — the China endpoint, measured 2026-10-20 on
 *   `deepseek-v4-pro`: the sentinel is answered `400` with "the request
 *   parameters were rejected by the model provider". The prose names no
 *   field, so it is readable for the same reason the global generic code is —
 *   the baseline has already been accepted with the *same* request except for
 *   `reasoning_effort`, which makes that field the only difference the
 *   rejection can be about. The baseline's own `max_tokens` floor was proved
 *   good by the accepted baseline, so this is not the `max_tokens` case.
 *
 * Neither is treated as a permanent protocol promise: anything unrecognized
 * still degrades to `unknown` rather than to a capability conclusion.
 */
const INVALID_EFFORT_CODES: Record<ProbeRegion, ReadonlySet<string>> = {
  cn: new Set(['invalid_reasoning_effort', 'invalid_parameter_value']),
  global: new Set(['invalid_reasoning_effort', 'model_param_invalid']),
}

/**
 * Error messages that name the effort value as the rejected parameter.
 *
 * The code alone is not enough on the CN endpoint: it answers the generic
 * `1210` for a bad `reasoning_effort` *and* for a request that omits the field
 * on a model that requires it (measured on `glm-5.1`, whose message reads "the
 * reasoning effort value is not supported by the current model"). Attributing
 * by code alone therefore missed a genuinely validating model, while
 * attributing every `1210` to effort would blame it for unrelated parameter
 * errors. The message is the only text that separates the two, so it is
 * matched explicitly and narrowly.
 *
 * Like the code sets, these are measurements, not protocol promises: a
 * rewording upstream degrades the affected model back to `unknown`, never to a
 * wrong capability claim.
 */
const INVALID_EFFORT_MESSAGES: Record<ProbeRegion, readonly RegExp[]> = {
  cn: [/reasoning[ _-]?effort[^.]*not supported/iu],
  global: [/reasoning[ _-]?effort[^.]*not supported/iu],
}

/** Whether an attempt is an attributable rejection of the effort value. */
function isEffortRejection(attempt: ProbeAttempt, region: ProbeRegion): boolean {
  if (attempt.status !== 400) return false
  if (attempt.errorCode !== undefined && INVALID_EFFORT_CODES[region].has(attempt.errorCode)) return true
  const message = attempt.errorMessage
  if (message === undefined) return false
  return INVALID_EFFORT_MESSAGES[region].some(pattern => pattern.test(message))
}

/** Whether an attempt shows the upstream accepted the request and streamed. */
function isAcceptance(attempt: ProbeAttempt): boolean {
  return attempt.status === 200 && attempt.streamed
}

/** Why an attempt ended in `unknown`, phrased for a log line. */
function unknownReason(stage: string, attempt: ProbeAttempt): string {
  const code = attempt.errorCode === undefined ? '' : ` (${attempt.errorCode})`
  const detail = attempt.detail === undefined ? '' : `: ${attempt.detail}`
  return `${stage} status ${attempt.status}${code}${detail}`
}

/**
 * Probe one model.
 *
 * `options.candidates` exists so tests can shorten the sweep; production always
 * uses {@link PROBE_EFFORT_CANDIDATES}. `options.region` selects which
 * endpoint's rejection vocabulary is read; it defaults to `cn`, which is also
 * the production default for the China app.
 *
 * `options.baselineEffort` is the effort the catalog declares the model uses by
 * default. Passing it changes the baseline from "omit the field" to "send the
 * declared value", which is required by models that reject an absent field
 * outright (measured on `glm-5.1`: omitting `reasoning_effort` is answered
 * `400` / `1210` "the reasoning effort value is not supported by the current
 * model", so an omitting baseline could never succeed and the model was
 * reported as undetectable for a reason that had nothing to do with the
 * parameter's accepted values). The baseline's job is to prove that a request
 * the upstream itself describes as valid is accepted; a declared default
 * serves that better than omission for exactly these models.
 */
export async function probeModel(options: {
  send: ProbeSender
  sentinel?: SentinelFactory
  candidates?: readonly WorkBuddyEffort[]
  timeoutMs?: number
  region?: ProbeRegion
  baselineEffort?: string
}): Promise<ProbeOutcome> {
  const sentinel = options.sentinel ?? randomSentinel
  const candidates = options.candidates ?? PROBE_EFFORT_CANDIDATES
  const timeoutMs = options.timeoutMs ?? PROBE_REQUEST_TIMEOUT_MS
  const region = options.region ?? 'cn'
  const baselineEffort = options.baselineEffort
  let requests = 0

  const attempt = async (effort: string | undefined, maxTokens?: number): Promise<ProbeAttempt> => {
    requests += 1
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await options.send(effort, controller.signal, maxTokens)
    } catch (error: unknown) {
      return { status: 0, streamed: false, detail: `transport error: ${String(error)}` }
    } finally {
      clearTimeout(timer)
    }
  }

  // 1. Baseline: proves the request path itself is sound. Without this a 400
  //    on the sentinel could just as well be an unrelated request problem.
  let baseline = await attempt(baselineEffort)
  if (!isAcceptance(baseline) && baseline.status === 400 && !isEffortRejection(baseline, region)) {
    // A 400 that is not about the effort value is a request-shape problem, and
    // the measured cause is the output ceiling sitting below the model's floor.
    // Retry once at a ceiling that clears it — as a fact about the request,
    // never as a conclusion about effort support. An *effort* rejection is
    // deliberately excluded: retrying it would spend a request to be told the
    // same thing twice.
    const retried = await attempt(baselineEffort, PROBE_BASELINE_RETRY_MAX_TOKENS)
    if (isAcceptance(retried)) {
      baseline = retried
    } else {
      return {
        validation: 'unknown',
        efforts: [],
        requests,
        reason: `${unknownReason('baseline', baseline)}; retry at max_tokens ${PROBE_BASELINE_RETRY_MAX_TOKENS}: ${unknownReason('baseline', retried)}`,
      }
    }
  }
  if (!isAcceptance(baseline)) {
    return { validation: 'unknown', efforts: [], requests, reason: unknownReason('baseline', baseline) }
  }

  // 2. Sentinel: the only step that can distinguish "validates the field" from
  //    "accepts anything".
  const probe = sentinel()
  const sentinelAttempt = await attempt(probe)
  if (isAcceptance(sentinelAttempt)) {
    // The upstream took a value that cannot exist. Any per-level acceptance
    // would be equally meaningless, so stop here rather than spend more
    // requests producing false positives.
    return { validation: 'non-validating', efforts: [], requests }
  }
  if (!isEffortRejection(sentinelAttempt, region)) {
    return { validation: 'unknown', efforts: [], requests, reason: unknownReason('sentinel', sentinelAttempt) }
  }

  // 3. Levels: meaningful only because the sentinel was refused.
  const accepted: WorkBuddyEffort[] = []
  for (const effort of candidates) {
    const levelAttempt = await attempt(effort)
    if (isAcceptance(levelAttempt)) {
      accepted.push(effort)
      continue
    }
    if (isEffortRejection(levelAttempt, region)) continue
    // A non-decisive answer mid-sweep: the partial list is not a finding, so
    // report the whole run as unknown rather than under-claiming a model.
    return {
      validation: 'unknown',
      efforts: [],
      requests,
      reason: unknownReason(`level ${effort}`, levelAttempt),
    }
  }

  return { validation: 'validating', efforts: accepted, requests }
}
