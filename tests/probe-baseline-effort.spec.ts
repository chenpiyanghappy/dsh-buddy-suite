import { describe, expect, it } from 'vitest'
import { probeModel } from '../src/probe.ts'
import type { ProbeAttempt, ProbeSender } from '../src/probe.ts'

/**
 * Models that reject an *absent* `reasoning_effort`.
 *
 * Measured on the CN endpoint with `glm-5.1`: a request that omits the field is
 * answered `400` / `1210` — "the reasoning effort value is not supported by the
 * current model". The probe's baseline omitted the field by design, so it could
 * never succeed on such a model, and the model was reported as "detection did
 * not complete" forever even though the upstream declares exactly which level
 * it runs at (`defaultEffort: 'medium'`).
 *
 * The fix has two halves that only work together:
 *
 * 1. the baseline sends the catalog's declared default effort instead of
 *    omitting it, so the model is asked in the form it accepts; and
 * 2. an unsupported effort is recognised by the upstream's *message*, because
 *    the CN endpoint reuses the generic `1210` code for this case.
 *
 * With only the first half the sentinel and every level would be answered
 * `1210`, which no code set matches, and the model would still end up
 * `unknown`.
 */

/** Answers from a scripted list, recording the effort each attempt carried. */
function scripted(attempts: ProbeAttempt[]): { send: ProbeSender, efforts: (string | undefined)[] } {
  const efforts: (string | undefined)[] = []
  let index = 0
  const send: ProbeSender = async effort => {
    efforts.push(effort)
    const attempt = attempts[index]
    index += 1
    if (attempt === undefined) throw new Error(`unscripted attempt ${index}`)
    return attempt
  }
  return { send, efforts }
}

const accepted: ProbeAttempt = { status: 200, streamed: true }
const effortNotSupported: ProbeAttempt = {
  status: 400,
  streamed: false,
  errorCode: '1210',
  errorMessage: 'the reasoning effort value is not supported by the current model',
  detail: '1210: the reasoning effort value is not supported by the current model',
}

describe('baseline uses the declared default effort', () => {
  it('sends the declared effort on the baseline attempt', async () => {
    const { send, efforts } = scripted([accepted, accepted])
    const outcome = await probeModel({ send, baselineEffort: 'medium' })

    // The baseline is the first request, and it carries the declared level.
    expect(efforts[0]).toBe('medium')
    expect(outcome.validation).toBe('non-validating')
  })

  it('keeps omitting the field when the catalog declares nothing', async () => {
    const { send, efforts } = scripted([accepted, accepted])
    await probeModel({ send })

    expect(efforts[0]).toBeUndefined()
  })

  it('measures a model that only answers when the field is present', async () => {
    // The real GLM-5.1 sequence: baseline('medium') accepted, sentinel refused
    // with the effort message, then the declared levels are swept.
    const { send, efforts } = scripted([
      accepted,
      effortNotSupported,
      accepted,            // low
      effortNotSupported,  // medium
      accepted,            // high
      effortNotSupported,  // xhigh
      effortNotSupported,  // max
    ])
    const outcome = await probeModel({ send, baselineEffort: 'medium' })

    expect(outcome.validation).toBe('validating')
    if (outcome.validation !== 'validating') throw new Error('expected validating')
    expect(outcome.efforts).toEqual(['low', 'high'])
    expect(efforts[0]).toBe('medium')
  })

  it('does not report a validated model as undetectable', async () => {
    // Regression guard for the reported symptom: the old baseline omitted the
    // field, got 1210, and gave up before asking anything else.
    const { send, efforts } = scripted([accepted, effortNotSupported, accepted, effortNotSupported, effortNotSupported, effortNotSupported, effortNotSupported])
    const outcome = await probeModel({ send, baselineEffort: 'low' })

    expect(outcome.validation).not.toBe('unknown')
    expect(efforts.length).toBeGreaterThan(1)
  })
})

describe('effort attribution by message', () => {
  it('attributes the generic CN code through the message', async () => {
    const { send } = scripted([accepted, effortNotSupported, accepted, effortNotSupported, effortNotSupported, effortNotSupported, effortNotSupported])
    const outcome = await probeModel({ send, baselineEffort: 'medium' })

    // Without the message rule this would be `unknown`.
    expect(outcome.validation).toBe('validating')
  })

  it('does not attribute a 1210 that is about another parameter', async () => {
    // Same code, different complaint: this must stay inconclusive rather than
    // be read as an effort rejection, or the probe would publish levels for a
    // request the upstream rejected for an unrelated reason.
    const { send } = scripted([
      accepted,
      { status: 400, streamed: false, errorCode: '1210', errorMessage: 'invalid max_tokens', detail: '1210: invalid max_tokens' },
    ])
    const outcome = await probeModel({ send, baselineEffort: 'medium' })

    expect(outcome.validation).toBe('unknown')
  })

  it('does not retry a baseline that was rejected because of the effort value', async () => {
    // Retrying a 400 that names the effort would spend a request to be told the
    // same thing; only request-shape rejections get the floor retry.
    const { send, efforts } = scripted([effortNotSupported])
    const outcome = await probeModel({ send, baselineEffort: 'medium' })

    expect(outcome.validation).toBe('unknown')
    expect(efforts).toHaveLength(1)
  })
})

/**
 * A second generic rejection code, measured on a different model.
 *
 * `deepseek-v4-pro` answers the sentinel with `400 /\`invalid_parameter_value\``
 * and "the request parameters were rejected by the model provider". The prose
 * names no field, but the baseline carrying the identical request (bar the
 * `reasoning_effort` value) had just been accepted, so that field is the only
 * difference the rejection can be about — the same argument the global
 * endpoint's generic code already rests on.
 *
 * Before this was recognised the model reported "sentinel status 400
 * (invalid_parameter_value)" and stayed undetected even though it is a fully
 * validating model.
 */
describe('generic parameter rejection on the sentinel', () => {
  const invalidParameterValue: ProbeAttempt = {
    status: 400,
    streamed: false,
    errorCode: 'invalid_parameter_value',
    errorMessage: 'the request parameters were rejected by the model provider',
    detail: 'invalid_parameter_value: the request parameters were rejected by the model provider',
  }

  it('treats it as an effort rejection once the baseline was accepted', async () => {
    const { send } = scripted([
      accepted,
      invalidParameterValue,
      accepted,            // low
      accepted,            // medium
      accepted,            // high
      accepted,            // xhigh
      accepted,            // max
    ])
    const outcome = await probeModel({ send, baselineEffort: 'high' })

    expect(outcome.validation).toBe('validating')
    if (outcome.validation !== 'validating') throw new Error('expected validating')
    expect(outcome.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('drops a level the upstream rejects with the same code', async () => {
    const { send } = scripted([
      accepted,
      invalidParameterValue,
      invalidParameterValue, // low refused
      accepted,              // medium
      invalidParameterValue, // high refused
      invalidParameterValue, // xhigh refused
      invalidParameterValue, // max refused
    ])
    const outcome = await probeModel({ send, baselineEffort: 'high' })

    expect(outcome.validation).toBe('validating')
    if (outcome.validation !== 'validating') throw new Error('expected validating')
    expect(outcome.efforts).toEqual(['medium'])
  })

  it('does not treat it as a rejection when the baseline itself failed', async () => {
    // Without an accepted baseline nothing proves the request shape is sound,
    // so the same body must stay inconclusive rather than be attributed.
    const { send } = scripted([
      { status: 400, streamed: false, errorCode: 'invalid_parameter_value', errorMessage: 'the request parameters were rejected by the model provider' },
      { status: 400, streamed: false, errorCode: 'invalid_parameter_value', errorMessage: 'the request parameters were rejected by the model provider' },
    ])
    const outcome = await probeModel({ send, baselineEffort: 'high' })

    expect(outcome.validation).toBe('unknown')
  })
})
