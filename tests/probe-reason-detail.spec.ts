import { describe, expect, it } from 'vitest'
import { probeModel } from '../src/probe.ts'
import type { ProbeAttempt, ProbeSender } from '../src/probe.ts'

/**
 * The upstream's own error prose must survive into the reason.
 *
 * The CN endpoint answers a generic parameter code (`1210`) for several
 * unrelated causes, and the international envelope uses different field names.
 * Keeping only the code meant a probe failure read "baseline status 400 (1210):
 * 1210" — a duplicate, with the one piece of information that identifies the
 * bad parameter thrown away.
 *
 * This spec pins the observable contract: whatever the sender puts in `detail`
 * reaches the recorded reason verbatim.
 */

function once(attempt: ProbeAttempt): ProbeSender {
  let used = false
  return async () => {
    if (used) return { status: 400, streamed: false, errorCode: 'unscripted' }
    used = true
    return attempt
  }
}

describe('reason keeps the upstream detail', () => {
  it('carries the upstream message through to the reason', async () => {
    const outcome = await probeModel({
      send: once({
        status: 400,
        streamed: false,
        errorCode: '1210',
        detail: '1210: 请求参数有误，max_tokens 超出范围',
      }),
    })

    expect(outcome.validation).toBe('unknown')
    if (outcome.validation !== 'unknown') throw new Error('expected unknown')
    expect(outcome.reason).toContain('1210')
    expect(outcome.reason).toContain('请求参数有误')
  })

  it('carries a transport failure through to the reason', async () => {
    const outcome = await probeModel({
      send: once({ status: 0, streamed: false, detail: 'transport error: fetch failed' }),
    })

    expect(outcome.validation).toBe('unknown')
    if (outcome.validation !== 'unknown') throw new Error('expected unknown')
    expect(outcome.reason).toContain('transport error: fetch failed')
  })
})
