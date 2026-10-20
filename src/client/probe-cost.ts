/**
 * What a batch detection is likely to cost.
 *
 * A batch spends the user's credit without them pressing anything per model, so
 * the confirmation has to price it. Request counts alone do not help: the catalog
 * quotes a per-request multiplier (`x0.79 credits`) and a user thinks in those.
 *
 * Two numbers, because one cannot be honest. A model that answers "not
 * adjustable" settles in two requests and stops; one that validates a full level
 * set spends one per level. So the estimate shows a *typical* figure (two
 * requests per model — what most CN rows actually do) and a *worst* case (the
 * documented ceiling, every level requested), and the confirmation says which is
 * which.
 *
 * Unknown prices are counted, not guessed: a row with no rate is reported as
 * unpriced rather than silently costing zero.
 *
 * @module dsh-buddy-suite/client/probe-cost
 */

/** Requests a model normally costs: one baseline, one sentinel. */
export const TYPICAL_REQUESTS_PER_MODEL = 2

/** Ceiling used by the confirmation: baseline, retry, sentinel, five levels. */
export const MAX_REQUESTS_PER_MODEL = 8

/** The estimate shown before a batch starts. */
export interface BatchCostEstimate {
  /** Credits if every model settles as "not adjustable". */
  typical: number
  /** Credits if every model sweeps all five levels. */
  worst: number
  /** Models whose rate the catalog does not quote. */
  unpriced: number
}

/** The fields this module needs from a catalog row. */
export interface PricedRow {
  id: string
  /** Raw upstream multiplier, e.g. `x0.79 credits`. */
  credits?: string
}

/**
 * Parse a per-request multiplier out of the catalog's raw rate string.
 *
 * The upstream spells this several ways (`x0.79 credits`, `x1.62`, `x0.00`), so
 * the parse takes the first `x`-prefixed number and ignores whatever follows.
 * Returns `undefined` rather than zero when there is nothing to read — a free
 * model and an unpriced one must not look alike.
 */
export function parseRequestRate(credits: string | undefined): number | undefined {
  if (credits === undefined) return undefined
  const match = /x(\d+(?:\.\d+)?)/iu.exec(credits)
  if (match === null) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) ? value : undefined
}

/**
 * Price a batch over the given model ids.
 *
 * Only the ids that will actually be visited are priced, so the figure tracks the
 * button the user is looking at.
 */
export function estimateBatchCost(rows: readonly PricedRow[], ids: readonly string[]): BatchCostEstimate {
  let typical = 0
  let worst = 0
  let unpriced = 0
  for (const id of ids) {
    const row = rows.find(entry => entry.id === id)
    const rate = parseRequestRate(row?.credits)
    if (rate === undefined) {
      unpriced += 1
      continue
    }
    typical += rate * TYPICAL_REQUESTS_PER_MODEL
    worst += rate * MAX_REQUESTS_PER_MODEL
  }
  return { typical, worst, unpriced }
}

/** Render a credit figure the way the catalog does: two decimals, no rounding surprises. */
export function formatCredits(value: number): string {
  return value.toFixed(2).replace(/\.00$/u, '')
}
