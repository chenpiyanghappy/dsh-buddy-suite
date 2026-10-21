import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyWorkBuddyFailure,
  clientHealthOf,
  healthStateOf,
  safeCall,
  WorkBuddyDegradedError,
  WorkBuddyHealthTracker,
  WorkBuddyUpstreamClient,
} from '../src/upstream.ts'
import { degradationMarker } from '../src/adapter.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import type { WorkBuddyCallStage, WorkBuddyDegradationCode } from '../src/status-paths.ts'

/**
 * T1 graceful degradation, offline.
 *
 * Every failure an upstream call can produce is folded into five closed codes;
 * the card, the CLI, and the picker branch on those codes and on `health`, so
 * the mapping itself is the contract. `fetch` is stubbed in every test that
 * reaches the client, so no request leaves the process.
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A CN credential; exactly the fields the client reads. */
const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'at',
  refreshToken: '',
  expiresAtMs: 4_102_444_800_000,
  domain: 'www.codebuddy.cn',
  uid: 'uid-1',
  source: 'desktop',
}

/** A JSON envelope response for the stubbed fetch. */
function envelope(body: unknown, ok = true, status = 200): Response {
  const text = JSON.stringify(body)
  return {
    ok,
    status,
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(body),
  } as unknown as Response
}

/** A non-JSON response, the shape a protocol change produces. */
function html(status = 200): Response {
  const text = '<html><body>gateway error</body></html>'
  return {
    ok: true,
    status,
    text: () => Promise.resolve(text),
    json: () => Promise.reject(new SyntaxError('Unexpected token <')),
  } as unknown as Response
}

/** The success envelope every credit read is expected to parse. */
const CREDITS_OK = {
  code: 0,
  data: { Response: { Data: { Accounts: [{ CyclePackageName: 'p', CycleCapacityRemain: 10 }] } } },
}

describe('classifyWorkBuddyFailure folds every failure into the closed vocabulary', () => {
  const cases: readonly { label: string, stage: WorkBuddyCallStage, error: unknown, code: WorkBuddyDegradationCode }[] = [
    {
      label: 'a rejected session is a missing credential',
      stage: 'refresh',
      error: new Error('workbuddy upstream session_dead (http 401): Offline user session not found'),
      code: 'CREDENTIAL_MISSING',
    },
    {
      label: 'an unusable at-rest key is a decryption failure',
      stage: 'credential',
      error: Object.assign(new Error('the at-rest protector key could not be derived'), { name: 'KeyUnavailableError' }),
      code: 'CREDENTIAL_DECRYPT_FAILED',
    },
    {
      label: 'a transport failure is an unreachable upstream',
      stage: 'catalog',
      error: new TypeError('fetch failed'),
      code: 'UPSTREAM_UNREACHABLE',
    },
    {
      label: 'an unreadable body is a protocol change',
      stage: 'catalog',
      error: new Error('workbuddy upstream returned non-JSON (http 200): <html>'),
      code: 'UPSTREAM_PROTOCOL_CHANGED',
    },
    {
      label: 'an HTTP 429 is a rate limit',
      stage: 'credits',
      error: new Error('workbuddy upstream soft_rate (http 429): slow down'),
      code: 'RATE_LIMITED',
    },
  ]

  for (const entry of cases) {
    it(entry.label, () => {
      const classified = classifyWorkBuddyFailure(entry.stage, entry.error)
      expect(classified.code).toBe(entry.code)
      expect(classified.stage).toBe(entry.stage)
      // The message is preserved for diagnosis, redacted and bounded.
      expect(classified.message.length).toBeGreaterThan(0)
    })
  }

  it('keeps the code of an already-classified error instead of re-deriving it', () => {
    const classified = classifyWorkBuddyFailure('credits', new WorkBuddyDegradedError('catalog', 'UPSTREAM_PROTOCOL_CHANGED', 'shape changed'))
    expect(classified.code).toBe('UPSTREAM_PROTOCOL_CHANGED')
    // The stage is the one recorded at the boundary, not the reader's guess.
    expect(classified.stage).toBe('catalog')
  })

  it('never leaks token material into the recorded message', () => {
    const classified = classifyWorkBuddyFailure('credits', new Error('refresh failed?access_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature'))
    expect(classified.message).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(classified.message).not.toContain('signature')
  })

  it('treats an unexplained registration failure as a host-seam change', () => {
    // Registration happens before any request: a failure here is a cordis /
    // pi-ai generation mismatch, not a network problem.
    expect(classifyWorkBuddyFailure('registration', new Error('service not available')).code).toBe('UPSTREAM_PROTOCOL_CHANGED')
  })
})

describe('health vocabularies stay consistent with the codes', () => {
  it('maps client health per code', () => {
    expect(clientHealthOf('RATE_LIMITED')).toBe('degraded')
    expect(clientHealthOf('UPSTREAM_UNREACHABLE')).toBe('degraded')
    expect(clientHealthOf('CREDENTIAL_MISSING')).toBe('down')
    expect(clientHealthOf('CREDENTIAL_DECRYPT_FAILED')).toBe('down')
    expect(clientHealthOf('UPSTREAM_PROTOCOL_CHANGED')).toBe('down')
  })

  it('maps the tri-state per code', () => {
    expect(healthStateOf('CREDENTIAL_MISSING')).toBe('credential_invalid')
    expect(healthStateOf('CREDENTIAL_DECRYPT_FAILED')).toBe('credential_invalid')
    expect(healthStateOf('UPSTREAM_UNREACHABLE')).toBe('upstream_changed')
    expect(healthStateOf('UPSTREAM_PROTOCOL_CHANGED')).toBe('upstream_changed')
    expect(healthStateOf('RATE_LIMITED')).toBe('upstream_changed')
  })
})

describe('safeCall', () => {
  it('returns the value on success', async () => {
    const outcome = await safeCall('catalog', async () => 42)
    expect(outcome).toEqual({ ok: true, value: 42 })
  })

  it('never throws and classifies the failure', async () => {
    const outcome = await safeCall('credits', async () => { throw new TypeError('fetch failed') })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected failure')
    expect(outcome.error).toBeInstanceOf(WorkBuddyDegradedError)
    expect(outcome.error.code).toBe('UPSTREAM_UNREACHABLE')
    expect(outcome.error.stage).toBe('credits')
    // The original error stays reachable for logs.
    expect(outcome.error.cause).toBeInstanceOf(TypeError)
  })
})

describe('the health tracker', () => {
  it('starts healthy and records the first failure', () => {
    const tracker = new WorkBuddyHealthTracker()
    expect(tracker.health).toBe('ok')
    expect(tracker.lastError).toBeUndefined()
    const recorded = tracker.record('checkin', new Error('rate limited (http 429)'))
    expect(recorded.code).toBe('RATE_LIMITED')
    expect(tracker.health).toBe('degraded')
    expect(tracker.lastError?.stage).toBe('checkin')
  })

  it('clears the stale diagnosis on the next success', () => {
    const tracker = new WorkBuddyHealthTracker()
    tracker.record('credits', new Error('workbuddy upstream returned non-JSON (http 200)'))
    expect(tracker.health).toBe('down')
    tracker.clear()
    expect(tracker.health).toBe('ok')
    expect(tracker.lastError).toBeUndefined()
  })
})

describe('the picker marker', () => {
  it('is absent while healthy', () => {
    expect(degradationMarker('ok', undefined)).toBeUndefined()
  })

  it('names the class when degraded', () => {
    // The LLM seam has no disabled/tooltip slot; the name is what the picker
    // renders, so the marker is the short diagnosis that reaches the user.
    expect(degradationMarker('degraded', { stage: 'credits', code: 'RATE_LIMITED', message: 'too many requests' }))
      .toBe('⚠ degraded (RATE_LIMITED)')
  })

  it('says unavailable when down', () => {
    expect(degradationMarker('down', { stage: 'catalog', code: 'UPSTREAM_PROTOCOL_CHANGED', message: 'shape changed' }))
      .toBe('⚠ unavailable (UPSTREAM_PROTOCOL_CHANGED)')
  })

  it('still marks the group when no classified error was retained', () => {
    expect(degradationMarker('down', undefined)).toBe('⚠ unavailable')
  })
})

describe('WorkBuddyUpstreamClient health transitions', () => {
  it('records a degraded state when the credit transport fails, then recovers', async () => {
    const client = new WorkBuddyUpstreamClient()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))

    await expect(client.fetchCredits(CREDENTIAL)).rejects.toBeInstanceOf(WorkBuddyDegradedError)
    expect(client.health).toBe('degraded')
    expect(client.lastError?.code).toBe('UPSTREAM_UNREACHABLE')
    expect(client.lastError?.stage).toBe('credits')

    // Recovery: the next successful read clears the diagnosis.
    vi.stubGlobal('fetch', vi.fn(async () => envelope(CREDITS_OK)))
    const credits = await client.fetchCredits(CREDENTIAL)
    expect(credits.total).toBe(10)
    expect(client.health).toBe('ok')
    expect(client.lastError).toBeUndefined()
  })

  it('reports a rate-limited catalog read as degraded', async () => {
    const client = new WorkBuddyUpstreamClient()
    vi.stubGlobal('fetch', vi.fn(async () => envelope({ code: 1, msg: 'too many requests' }, false, 429)))

    await expect(client.fetchModels(CREDENTIAL)).rejects.toBeInstanceOf(WorkBuddyDegradedError)
    expect(client.health).toBe('degraded')
    expect(client.lastError?.code).toBe('RATE_LIMITED')
    expect(client.lastError?.stage).toBe('catalog')
  })

  it('reports a malformed catalog document as down', async () => {
    const client = new WorkBuddyUpstreamClient()
    vi.stubGlobal('fetch', vi.fn(async () => html()))

    await expect(client.fetchModels(CREDENTIAL)).rejects.toBeInstanceOf(WorkBuddyDegradedError)
    expect(client.health).toBe('down')
    expect(client.lastError?.code).toBe('UPSTREAM_PROTOCOL_CHANGED')
  })

  it('reports a dead session during a token refresh as a credential failure', async () => {
    const client = new WorkBuddyUpstreamClient()
    vi.stubGlobal('fetch', vi.fn(async () => envelope({ code: 1, msg: 'Offline user session not found' }, false, 401)))

    await expect(client.refreshToken(CREDENTIAL)).rejects.toBeInstanceOf(WorkBuddyDegradedError)
    expect(client.health).toBe('down')
    expect(client.lastError?.code).toBe('CREDENTIAL_MISSING')
    expect(client.lastError?.stage).toBe('refresh')
  })

  it('accepts an externally classified registration failure', () => {
    // `index.ts` records provider-registration failures through this seam: the
    // card must be able to say why a variant never appeared.
    const client = new WorkBuddyUpstreamClient()
    client.noteFailure('registration', new Error('ctx.llm.registerAdapter is not a function'))
    expect(client.health).toBe('down')
    expect(client.lastError?.stage).toBe('registration')
    client.noteSuccess()
    expect(client.health).toBe('ok')
  })
})
