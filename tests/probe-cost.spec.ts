import { describe, expect, it } from 'vitest'
import {
  MAX_REQUESTS_PER_MODEL,
  TYPICAL_REQUESTS_PER_MODEL,
  estimateBatchCost,
  formatCredits,
  parseRequestRate,
} from '../src/client/probe-cost.ts'

/**
 * Pricing a batch before it runs.
 *
 * The batch spends credit without a per-model click, so the confirmation has to
 * say how much. Request counts alone do not help — the catalog quotes a
 * per-request multiplier and that is the unit the user thinks in.
 *
 * The two numbers exist because one would lie: a model that answers "not
 * adjustable" settles in two requests, while a validating one spends one per
 * level. Showing only the worst case would scare users off a normally cheap
 * action; showing only the typical would understate a validating sweep.
 */

describe('parseRequestRate', () => {
  it('reads the multiplier out of the shapes the catalog ships', () => {
    // Measured spellings: with the unit word, bare, and free.
    expect(parseRequestRate('x0.79 credits')).toBe(0.79)
    expect(parseRequestRate('x1.62')).toBe(1.62)
    expect(parseRequestRate('x0.00 credits')).toBe(0)
    expect(parseRequestRate('x3.31 credits')).toBe(3.31)
  })

  it('returns undefined when there is nothing to read', () => {
    // An unpriced model and a free one must not both look like zero.
    expect(parseRequestRate(undefined)).toBeUndefined()
    expect(parseRequestRate('')).toBeUndefined()
    expect(parseRequestRate('free')).toBeUndefined()
  })
})

describe('estimateBatchCost', () => {
  const rows = [
    { id: 'cheap', credits: 'x0.10 credits' },
    { id: 'pricey', credits: 'x0.79 credits' },
    { id: 'free', credits: 'x0.00 credits' },
  ]

  it('prices only the models the batch will visit', () => {
    const estimate = estimateBatchCost(rows, ['cheap'])

    expect(estimate.typical).toBeCloseTo(0.10 * TYPICAL_REQUESTS_PER_MODEL)
    expect(estimate.worst).toBeCloseTo(0.10 * MAX_REQUESTS_PER_MODEL)
  })

  it('sums across the work list', () => {
    const estimate = estimateBatchCost(rows, ['cheap', 'pricey'])

    expect(estimate.typical).toBeCloseTo((0.10 + 0.79) * TYPICAL_REQUESTS_PER_MODEL)
    expect(estimate.worst).toBeCloseTo((0.10 + 0.79) * MAX_REQUESTS_PER_MODEL)
    expect(estimate.unpriced).toBe(0)
  })

  it('treats a free model as priced at zero, not as unknown', () => {
    const estimate = estimateBatchCost(rows, ['free'])

    expect(estimate.typical).toBe(0)
    expect(estimate.worst).toBe(0)
    expect(estimate.unpriced).toBe(0)
  })

  it('counts models whose rate the catalog does not quote', () => {
    const estimate = estimateBatchCost(rows, ['cheap', 'mystery'])

    expect(estimate.unpriced).toBe(1)
    expect(estimate.typical).toBeCloseTo(0.10 * TYPICAL_REQUESTS_PER_MODEL)
  })

  it('keeps the worst case above the typical one', () => {
    const estimate = estimateBatchCost(rows, ['cheap', 'pricey'])
    expect(estimate.worst).toBeGreaterThan(estimate.typical)
  })

  it('is zero for an empty work list', () => {
    expect(estimateBatchCost(rows, [])).toEqual({ typical: 0, worst: 0, unpriced: 0 })
  })
})

describe('formatCredits', () => {
  it('prints two decimals without a trailing .00', () => {
    expect(formatCredits(1.58)).toBe('1.58')
    expect(formatCredits(2)).toBe('2')
    expect(formatCredits(0.1 + 0.2)).toBe('0.30')
  })
})
