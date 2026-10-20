import { describe, expect, it } from 'vitest'
import { buildDiagnosticsBundle, hasDiagnosableState } from '../src/client/diagnostics.ts'
import type { WorkBuddyWebStatus } from '../src/status-paths.ts'

/**
 * The diagnostics bundle.
 *
 * A user pastes this into an issue, a chat, or an agent session. That is what
 * makes it useful and what makes its one hard requirement non-negotiable: it must
 * not carry `probeKey`, the in-process secret that authorizes credit-spending
 * writes for the lifetime of the process. A bundle with the key in it turns every
 * pasted report into a way to spend the reporter's credit.
 *
 * Everything else is kept deliberately — the raw reasons are the whole point of
 * the export.
 */

const SIGNED_IN: WorkBuddyWebStatus = {
  status: 'signed-in',
  nickname: 'tester',
  domain: 'workbuddy.cn',
  credits: {
    total: 13486,
    expiry: { within24h: { total: 0, packages: 0 }, within3d: { total: 0, packages: 0 }, within7d: { total: 0, packages: 0 } },
    accounts: [
      { packageName: 'package-A', remain: 100, size: 100, endTimeMs: 1 },
      { packageName: 'package-B', remain: 0, size: 100, endTimeMs: 2 },
      { packageName: 'package-C', remain: 50, size: 100, endTimeMs: 3 },
    ],
  },
  probeKey: 'super-secret-control-key',
  probe: {
    consent: true,
    running: false,
    candidates: ['glm-5.1'],
    results: [{
      id: 'glm-5.1',
      name: 'GLM-5.1',
      validation: 'unknown',
      efforts: [],
      probedAt: 1,
      reason: 'baseline status 400 (1210): 1210: the reasoning effort value is not supported',
    }],
  },
}

const identity = { packageName: 'dsh-buddy-suite', provider: 'workbuddy-suite' }

describe('buildDiagnosticsBundle', () => {
  it('never carries the control key', () => {
    const bundle = buildDiagnosticsBundle(SIGNED_IN, identity, '2026-10-20T00:00:00.000Z')
    const text = JSON.stringify(bundle)

    expect(text).not.toContain('super-secret-control-key')
    expect('probeKey' in bundle.status).toBe(false)
    expect(text).not.toContain('probeKey')
  })

  it('keeps the evidence the report exists for', () => {
    const bundle = buildDiagnosticsBundle(SIGNED_IN, identity, '2026-10-20T00:00:00.000Z')

    expect(bundle.status.status).toBe('signed-in')
    if (bundle.status.status !== 'signed-in') throw new Error('expected signed-in')
    // The raw reason is the reason this export exists.
    expect(bundle.status.probe?.results[0]?.reason).toContain('1210')
    expect(bundle.status.nickname).toBe('tester')
    expect(bundle.status.credits?.total).toBe(13486)
  })

  it('slims the credit ledger to a count', () => {
    // A real account carried 49 packages; pasting them buries the part of the
    // report a reader needs. The total, the expiry buckets and the row count are
    // the parts that answer questions.
    const bundle = buildDiagnosticsBundle(SIGNED_IN, identity, '2026-10-20T00:00:00.000Z')
    const text = JSON.stringify(bundle)

    expect(text).not.toContain('package-A')
    expect(bundle.status.status).toBe('signed-in')
    if (bundle.status.status !== 'signed-in') throw new Error('expected signed-in')
    expect(bundle.status.credits).toMatchObject({ total: 13486, accountCount: 3 })
    expect(bundle.status.credits?.expiry).toBeDefined()
  })

  it('records which provider and when', () => {
    const bundle = buildDiagnosticsBundle(SIGNED_IN, identity, '2026-10-20T00:00:00.000Z')

    expect(bundle.provider).toBe('workbuddy-suite')
    expect(bundle.packageName).toBe('dsh-buddy-suite')
    expect(bundle.generatedAt).toBe('2026-10-20T00:00:00.000Z')
  })

  it('includes the version only when it is known', () => {
    const withoutVersion = buildDiagnosticsBundle(SIGNED_IN, identity, '2026-10-20T00:00:00.000Z')
    expect('version' in withoutVersion).toBe(false)

    const withVersion = buildDiagnosticsBundle(
      SIGNED_IN,
      { ...identity, version: '0.1.2' },
      '2026-10-20T00:00:00.000Z',
    )
    expect(withVersion.version).toBe('0.1.2')
  })

  it('passes a signed-out document through unchanged', () => {
    const signedOut: WorkBuddyWebStatus = { status: 'signed-out', reason: 'no credential', reasonCode: 'no-credential' }
    const bundle = buildDiagnosticsBundle(signedOut, identity, '2026-10-20T00:00:00.000Z')

    expect(bundle.status).toEqual(signedOut)
  })

  it('passes an error document through unchanged', () => {
    const failed: WorkBuddyWebStatus = { status: 'error', message: 'HTTP 500' }
    expect(buildDiagnosticsBundle(failed, identity, '2026-10-20T00:00:00.000Z').status).toEqual(failed)
  })

  it('does not mutate the document it was given', () => {
    // The caller's `status` is React state; stripping in place would delete the
    // live key and break every later control request.
    buildDiagnosticsBundle(SIGNED_IN, identity, '2026-10-20T00:00:00.000Z')
    expect(SIGNED_IN.status === 'signed-in' && SIGNED_IN.probeKey).toBe('super-secret-control-key')
  })
})

describe('hasDiagnosableState', () => {
  it('is false before the first successful read', () => {
    expect(hasDiagnosableState(undefined)).toBe(false)
  })

  it('is true for a signed-in document', () => {
    expect(hasDiagnosableState(SIGNED_IN)).toBe(true)
  })

  it('is true for an error document', () => {
    expect(hasDiagnosableState({ status: 'error', message: 'boom' })).toBe(true)
  })

  it('is false for a bare signed-out document with no reason', () => {
    expect(hasDiagnosableState({ status: 'signed-out' })).toBe(false)
  })

  it('is true for a signed-out document that explains itself', () => {
    expect(hasDiagnosableState({ status: 'signed-out', reason: 'app not found' })).toBe(true)
  })
})
