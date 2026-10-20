import { describe, expect, it } from 'vitest'
import {
  PROBE_BASELINE_RETRY_MAX_TOKENS,
  PROBE_MAX_TOKENS,
  probeModel,
} from '../src/probe.ts'
import type { ProbeAttempt, ProbeSender } from '../src/probe.ts'

/**
 * The baseline floor retry.
 *
 * A probe's first request carries no `reasoning_effort` at all, so a 400 on it
 * cannot be a complaint about effort. Measured on the CN endpoint, `glm-5.1`
 * answers a bare parameter error (400 / `1210`) when the request asks for
 * `max_tokens: 1`, and the probe then reported "detection did not complete" for
 * a perfectly capable model. The retry lets that model be measured instead of
 * written off, while still never claiming anything about effort support from an
 * inconclusive run.
 *
 * The retry is deliberately confined to the baseline: applying it to the
 * sentinel or level attempts would double the cost of every genuine rejection.
 */

/** A sender that answers a scripted list of attempts, recording each call. */
function scripted(attempts: ProbeAttempt[]): { send: ProbeSender, calls: { effort: string | undefined, maxTokens: number | undefined }[] } {
  const calls: { effort: string | undefined, maxTokens: number | undefined }[] = []
  let index = 0
  const send: ProbeSender = async (effort, _signal, maxTokens) => {
    calls.push({ effort, maxTokens })
    const attempt = attempts[index]
    index += 1
    if (attempt === undefined) throw new Error(`unscripted attempt ${index}`)
    return attempt
  }
  return { send, calls }
}

const accepted: ProbeAttempt = { status: 200, streamed: true }
const floorRejection: ProbeAttempt = { status: 400, streamed: false, errorCode: '1210', detail: '1210: 参数错误' }
const effortRejection: ProbeAttempt = { status: 400, streamed: false, errorCode: 'invalid_reasoning_effort' }

describe('baseline floor retry', () => {
  it('retries a rejected baseline at a larger ceiling', async () => {
    // baseline(1) fails, baseline(retry) succeeds, sentinel accepted → the model
    // is non-validating, which is a real observation rather than "unknown".
    const { send, calls } = scripted([floorRejection, accepted, accepted])
    const outcome = await probeModel({ send })

    expect(calls[0]).toEqual({ effort: undefined, maxTokens: undefined })
    expect(calls[1]).toEqual({ effort: undefined, maxTokens: PROBE_BASELINE_RETRY_MAX_TOKENS })
    expect(calls[1]!.maxTokens).toBeGreaterThan(PROBE_MAX_TOKENS)
    expect(outcome).toMatchObject({ validation: 'non-validating', requests: 3 })
  })

  it('keeps the small ceiling for the sentinel and level attempts', async () => {
    // A genuine effort rejection must still cost one request per attempt: the
    // retry belongs to the baseline only.
    const { send, calls } = scripted([floorRejection, accepted, effortRejection, accepted, effortRejection, effortRejection, effortRejection, effortRejection])
    const outcome = await probeModel({ send })

    expect(outcome.validation).toBe('validating')
    const sentinelAndLevels = calls.slice(2)
    expect(sentinelAndLevels.length).toBeGreaterThan(0)
    for (const call of sentinelAndLevels) expect(call.maxTokens).toBeUndefined()
  })

  it('does not retry when the baseline already succeeded', async () => {
    const { send, calls } = scripted([accepted, accepted])
    const outcome = await probeModel({ send })

    expect(outcome.validation).toBe('non-validating')
    expect(calls).toHaveLength(2)
    expect(calls.every(call => call.maxTokens === undefined)).toBe(true)
  })

  it('reports both attempts when the retry fails too', async () => {
    const { send, calls } = scripted([floorRejection, floorRejection])
    const outcome = await probeModel({ send })

    expect(outcome.validation).toBe('unknown')
    expect(calls).toHaveLength(2)
    if (outcome.validation !== 'unknown') throw new Error('expected unknown')
    // The reason names the original code and the retry ceiling, so the next
    // reader can tell a floor problem from an auth or transport problem.
    expect(outcome.reason).toContain('1210')
    expect(outcome.reason).toContain(`max_tokens ${PROBE_BASELINE_RETRY_MAX_TOKENS}`)
    expect(outcome.reason).toContain('参数错误')
  })

  it('does not retry a non-400 baseline failure', async () => {
    // A 401/500 is not a parameter floor; retrying it would spend a request to
    // learn nothing.
    const { send, calls } = scripted([{ status: 401, streamed: false, errorCode: 'unauthorized' }])
    const outcome = await probeModel({ send })

    expect(outcome.validation).toBe('unknown')
    expect(calls).toHaveLength(1)
  })
})
