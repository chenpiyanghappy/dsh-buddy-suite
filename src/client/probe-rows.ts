/**
 * Presentation rules for the reasoning-probe panel's model rows.
 *
 * Two problems made that panel hard to use, and both live in how rows are
 * *labelled and ordered* rather than in the probe itself:
 *
 * 1. **Duplicate names.** The CN catalog ships `hy3` and `hy3-x` with the same
 *    `name`, "Hy3" — two different products (one free at `x0.00`, the other at
 *    `x0.05`) that a name-only row cannot tell apart.
 * 2. **Value-blind order.** Eleven models are probeable there and nine answer
 *    "not adjustable". In catalog order, the one row that actually carries
 *    selectable levels sits at the very bottom of the panel.
 *
 * Kept in its own module, free of React and of the DOM, so the rules can be
 * tested directly instead of through a rendered component.
 *
 * @module dsh-buddy-suite/client/probe-rows
 */

import type { WorkBuddyWebModelBadge, WorkBuddyWebProbeModel } from '../status-paths.ts'

/**
 * The distinguishing rate for one duplicated model name.
 *
 * `credits` arrives in the host's language-neutral display form (`x0.05`), but
 * an upstream row can append a unit word (`x0.05 credits`); inside a chip that
 * word is both long and English-only. The multiplier alone is what separates
 * the pair, so a trailing unit word is dropped here.
 */
export function rateLabel(credits: string): string {
  return credits.replace(/\s+credits?$/iu, '').trim()
}

/**
 * Display names for the detectable models, disambiguated where the upstream
 * reuses one name for several ids.
 *
 * Only *repeated* names are qualified: appending an id to every row would turn
 * a clean list into noise for the models whose names are already unique.
 *
 * @param candidates - the ids being listed, in display order.
 * @param models - the catalog rows backing them (name, rate).
 * @returns one label per candidate, index-aligned with `candidates`.
 */
export function disambiguatedLabels(
  candidates: readonly string[],
  models: readonly WorkBuddyWebModelBadge[] | undefined,
): string[] {
  const rows = candidates.map(id => models?.find(model => model.id === id))
  const base = candidates.map((id, index) => rows[index]?.name ?? id)
  const counts = new Map<string, number>()
  for (const label of base) counts.set(label, (counts.get(label) ?? 0) + 1)

  return base.map((label, index) => {
    if ((counts.get(label) ?? 0) <= 1) return label
    const row = rows[index]
    // The rate is what actually differs between the two Hy3 rows, and it is
    // also the reason a user would choose one over the other.
    if (row?.credits !== undefined) return `${label} · ${rateLabel(row.credits)}`
    return `${label} · ${candidates[index]}`
  })
}

/**
 * Rank the detectable models so the rows a user can act on come first.
 *
 * The order below is by information value:
 *
 * 1. `validating` with levels: something the user can act on.
 * 2. never detected: something the user can *do* (press Detect).
 * 3. `non-validating`: a settled answer with no action attached.
 * 4. `unknown`: needs a retry, and is the most likely to change.
 *
 * Ties keep catalog order, so rows do not shuffle between renders.
 *
 * A `validating` record with an empty level list is treated as case 4 rather
 * than 1: the probe never stores that shape, but a malformed wire value must
 * not claim the top slot that belongs to a real level list.
 */
export function rankedCandidates(
  candidates: readonly string[],
  results: readonly WorkBuddyWebProbeModel[],
  models: readonly WorkBuddyWebModelBadge[] | undefined,
): { ids: string[], labels: string[] } {
  const byId = new Map(results.map(result => [result.id, result]))
  const rank = (id: string): number => {
    const result = byId.get(id)
    if (result === undefined) return 1
    if (result.validation === 'validating' && result.efforts.length > 0) return 0
    if (result.validation === 'non-validating') return 2
    return 3
  }
  const ids = candidates
    .map((id, index) => ({ id, index, rank: rank(id) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(entry => entry.id)
  return { ids, labels: disambiguatedLabels(ids, models) }
}

/** The locale binder this module needs; narrowed to the keys it reads. */
export type ProbeChipTranslator = (
  key: 'probeResultNotValidating' | 'probeResultUnknown' | 'probeDeclaredSuffix',
  params?: Record<string, unknown>,
) => string

/**
 * The chip text for one recorded detection.
 *
 * A `validating` record shows the accepted levels. A `non-validating` one says
 * the level cannot be chosen — and, when the catalog names the effort the model
 * uses anyway, appends that level in parentheses. "Not adjustable" alone leaves
 * the reader unable to tell what the model does instead, which is the gap the
 * catalog suffix fills.
 *
 * `declaredEfforts` wins over `defaultEffort` when both are present: it is the
 * full set the row declares, and naming the set says more than naming the one
 * level the upstream happens to pick.
 */
export function probeChipText(
  result: WorkBuddyWebProbeModel,
  model: WorkBuddyWebModelBadge | undefined,
  t: ProbeChipTranslator,
): string {
  if (result.validation === 'validating' && result.efforts.length > 0) {
    return result.efforts.join(' / ')
  }
  if (result.validation !== 'non-validating') return t('probeResultUnknown')
  const declared = (model?.declaredEfforts?.length ?? 0) > 0
    ? model!.declaredEfforts!.join(' / ')
    : model?.defaultEffort
  const base = t('probeResultNotValidating')
  return declared === undefined || declared === ''
    ? base
    : `${base}${t('probeDeclaredSuffix', { levels: declared })}`
}
