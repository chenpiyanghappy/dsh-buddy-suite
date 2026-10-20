import { describe, expect, it } from 'vitest'
import { diagnoseProbeReason } from '../src/client/probe-diagnosis.ts'

/**
 * Failure diagnoses.
 *
 * The recorded reason is deliberately raw — it carries the stage, the HTTP
 * status, and the upstream's own code and prose so a report is actionable. That
 * is also why it cannot be shown as-is: the CN endpoint answers `1210` for
 * several unrelated causes and the international one answers
 * `invalid_parameter_value` with text that names no field.
 *
 * These specs pin the mapping from measured strings to a sentence a user can act
 * on, and — more importantly — that an unrecognized record produces no diagnosis
 * at all rather than a confident guess.
 */

describe('diagnoseProbeReason', () => {
  it('recognizes a request that never reached the upstream', () => {
    expect(diagnoseProbeReason('baseline status 0: transport error: fetch failed')).toBe('probeDiagTransport')
  })

  it('recognizes an expired sign-in', () => {
    expect(diagnoseProbeReason('baseline status 401 (unauthorized): unauthorized')).toBe('probeDiagAuth')
    expect(diagnoseProbeReason('baseline status 403 (forbidden): forbidden')).toBe('probeDiagAuth')
  })

  it('recognizes rate limiting', () => {
    expect(diagnoseProbeReason('sentinel status 429 (too_many_requests)')).toBe('probeDiagRateLimit')
  })

  it('recognizes an upstream-side failure', () => {
    expect(diagnoseProbeReason('baseline status 502 (bad_gateway)')).toBe('probeDiagServer')
  })

  it('recognizes a model the endpoint does not know', () => {
    expect(diagnoseProbeReason('baseline status 400 (11102): unknown model')).toBe('probeDiagUnknownModel')
  })

  it('recognizes a max_tokens floor', () => {
    expect(diagnoseProbeReason('baseline status 400 (11133): integer_below_min_value'))
      .toBe('probeDiagMaxTokens')
  })

  it('recognizes a refused reasoning level by its message', () => {
    // The measured GLM-5.1 shape: the generic CN code plus a message that
    // names the field.
    expect(diagnoseProbeReason(
      'baseline status 400 (1210): 1210: the reasoning effort value is not supported by the current model',
    )).toBe('probeDiagEffortRejected')
  })

  it('recognizes a refused reasoning level by its code', () => {
    expect(diagnoseProbeReason('sentinel status 400 (invalid_reasoning_effort)'))
      .toBe('probeDiagEffortRejected')
    expect(diagnoseProbeReason('sentinel status 400 (invalid_parameter_value): the request parameters were rejected'))
      .toBe('probeDiagEffortRejected')
  })

  it('prefers the specific effort message over the generic code', () => {
    // `1210` alone is generic; the message is what makes it specific. Ordering
    // is the whole reason the patterns are declared most-specific-first.
    const withMessage = 'baseline status 400 (1210): 1210: the reasoning effort value is not supported'
    const bareCode = 'baseline status 400 (1210): 1210'
    expect(diagnoseProbeReason(withMessage)).toBe('probeDiagEffortRejected')
    expect(diagnoseProbeReason(bareCode)).toBe('probeDiagParameter')
  })

  it('returns nothing for an unrecognized or absent reason', () => {
    // Never invent a cause: the caller falls back to the raw text.
    expect(diagnoseProbeReason(undefined)).toBeUndefined()
    expect(diagnoseProbeReason('')).toBeUndefined()
    expect(diagnoseProbeReason('   ')).toBeUndefined()
    expect(diagnoseProbeReason('something the upstream said that we have never seen')).toBeUndefined()
  })

  it('recognizes the retry form of a double baseline failure', () => {
    // `probeModel` records both baselines when the floor retry also fails.
    const reason = 'baseline status 400 (1210): x; retry at max_tokens 16: baseline status 400 (1210): x'
    expect(diagnoseProbeReason(reason)).toBe('probeDiagParameter')
  })
})
