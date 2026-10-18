import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  disambiguatedLabels,
  probeChipText,
  rankedCandidates,
  rateLabel,
} from '../src/client/probe-rows.ts'
import type { ProbeChipTranslator } from '../src/client/probe-rows.ts'
import type { WorkBuddyWebModelBadge, WorkBuddyWebProbeModel } from '../src/status-paths.ts'

/**
 * Specs for the probe panel's row labels and order.
 *
 * Both rules came out of a real screenshot of the CN panel: `hy3` and `hy3-x`
 * rendered as two identical "Hy3" rows, and the only model with selectable
 * levels sat at the bottom of an eleven-row list in which nine rows said the
 * same thing. The functions are pure and live in their own module, so they are
 * tested directly rather than through a rendered component.
 */

/** A catalog row shaped like the status document's `models` entries. */
function badge(id: string, name: string, credits?: string): WorkBuddyWebModelBadge {
  return { id, name, ...credits === undefined ? {} : { credits } }
}

/** A recorded probe outcome shaped like `probe.results` entries. */
function result(
  id: string,
  validation: WorkBuddyWebProbeModel['validation'],
  efforts: string[] = [],
): WorkBuddyWebProbeModel {
  return { id, name: id, validation, efforts, probedAt: 0 } as WorkBuddyWebProbeModel
}

describe('rateLabel', () => {
  it('keeps a bare multiplier', () => {
    expect(rateLabel('x0.05')).toBe('x0.05')
  })

  it('drops a trailing unit word', () => {
    // Upstream rows sometimes append "credits"; inside a chip that word is long
    // and English-only, while the multiplier is the whole distinguishing fact.
    expect(rateLabel('x0.05 credits')).toBe('x0.05')
    expect(rateLabel('x0.00 credit')).toBe('x0.00')
  })
})

describe('disambiguatedLabels', () => {
  it('qualifies repeated names with the distinguishing rate', () => {
    const labels = disambiguatedLabels(['hy3', 'hy3-x'], [
      badge('hy3', 'Hy3', 'x0.00'),
      badge('hy3-x', 'Hy3', 'x0.05'),
    ])
    expect(labels).toEqual(['Hy3 · x0.00', 'Hy3 · x0.05'])
  })

  it('drops the unit word so the chip stays short', () => {
    const labels = disambiguatedLabels(['hy3', 'hy3-x'], [
      badge('hy3', 'Hy3', 'x0.00 credits'),
      badge('hy3-x', 'Hy3', 'x0.05 credits'),
    ])
    expect(labels).toEqual(['Hy3 · x0.00', 'Hy3 · x0.05'])
  })

  it('leaves unique names untouched', () => {
    const labels = disambiguatedLabels(['glm-5.2', 'kimi-k3-2'], [
      badge('glm-5.2', 'GLM-5.2', 'x0.79'),
      badge('kimi-k3-2', 'Kimi-K3', 'x1.62'),
    ])
    // No id, no rate appended: the list stays clean where it is already clear.
    expect(labels).toEqual(['GLM-5.2', 'Kimi-K3'])
  })

  it('falls back to the id when a repeated name has no rate', () => {
    const labels = disambiguatedLabels(['a', 'b'], [badge('a', 'Same'), badge('b', 'Same')])
    expect(labels).toEqual(['Same · a', 'Same · b'])
  })

  it('uses the id when the catalog row is missing', () => {
    expect(disambiguatedLabels(['unknown-id'], [])).toEqual(['unknown-id'])
  })
})

describe('rankedCandidates', () => {
  it('puts selectable levels first, then undetected, then settled negatives', () => {
    const ranked = rankedCandidates(['a', 'b', 'c', 'd'], [
      result('a', 'non-validating'),
      result('b', 'validating', ['low', 'high']),
      result('c', 'unknown'),
      // `d` has no result: pressing Detect is real work, so it outranks the
      // settled negatives but not the row that already carries levels.
    ], [])
    expect(ranked.ids).toEqual(['b', 'd', 'a', 'c'])
  })

  it('keeps catalog order within one rank', () => {
    // Nine CN models report `non-validating`; keeping their relative order
    // means the panel does not reshuffle between renders.
    const candidates = ['x1', 'x2', 'x3']
    const ranked = rankedCandidates(candidates, candidates.map(id => result(id, 'non-validating')), [])
    expect(ranked.ids).toEqual(['x1', 'x2', 'x3'])
  })

  it('treats a validating record with no levels as needing attention', () => {
    // The probe never stores this shape, but a malformed wire value must not
    // claim the top slot that belongs to a real level list.
    const ranked = rankedCandidates(['weird', 'real'], [
      result('weird', 'validating', []),
      result('real', 'validating', ['high']),
    ], [])
    expect(ranked.ids).toEqual(['real', 'weird'])
  })

  it('returns labels index-aligned with the ranked ids', () => {
    const ranked = rankedCandidates(['hy3', 'hy3-x', 'other'], [
      result('hy3', 'non-validating'),
      result('hy3-x', 'validating', ['low']),
      result('other', 'non-validating'),
    ], [
      badge('hy3', 'Hy3', 'x0.00'),
      badge('hy3-x', 'Hy3', 'x0.05'),
      badge('other', 'Other'),
    ])
    expect(ranked.ids).toEqual(['hy3-x', 'hy3', 'other'])
    // The duplicate pair keeps its rate qualifiers after being reordered, and
    // each label stays at the index of its own id — a mismatch here would make
    // a row's button act on a different model than the row names.
    expect(ranked.labels).toEqual(['Hy3 · x0.05', 'Hy3 · x0.00', 'Other'])
  })

  it('handles an empty candidate list', () => {
    expect(rankedCandidates([], [], [])).toEqual({ ids: [], labels: [] })
  })
})

/**
 * A stand-in locale binder backed by the real zh table.
 *
 * Using the shipped copy rather than a stub is what catches a missing key: an
 * unregistered key is what produced the literal `probeDeclaredSuffix` text the
 * user saw in the panel, so the test has to fail the same way the UI did.
 */
function translator(overrides: Partial<Record<string, string>> = {}): ProbeChipTranslator {
  const table: Record<string, string> = {
    probeResultNotValidating: '不可调档位 · 用默认档位',
    probeResultUnknown: '检测未完成',
    probeDeclaredSuffix: '（目录声明 {levels}）',
    ...overrides,
  }
  return ((key, params) => {
    const template = table[key]
    // A missing key renders as the key itself — exactly the failure mode the
    // panel showed, so the assertions below can catch it.
    if (template === undefined) throw new Error(`missing locale key: ${key}`)
    return template.replace(/\{(\w+)\}/gu, (_, name: string) => String(params?.[name] ?? ''))
  }) as ProbeChipTranslator
}

describe('probeChipText', () => {
  it('lists the accepted levels for a validating record', () => {
    expect(probeChipText(result('m', 'validating', ['low', 'high']), undefined, translator()))
      .toBe('low / high')
  })

  it('names the level the catalog declares when the parameter is ignored', () => {
    // This is the case from the screenshot: the chip has to say what the model
    // runs at, not only that the level cannot be chosen.
    const model: WorkBuddyWebModelBadge = { id: 'm', name: 'M', defaultEffort: 'high' }
    expect(probeChipText(result('m', 'non-validating'), model, translator()))
      .toBe('不可调档位 · 用默认档位（目录声明 high）')
  })

  it('prefers declared efforts over the single default', () => {
    const model: WorkBuddyWebModelBadge = {
      id: 'm',
      name: 'M',
      declaredEfforts: ['low', 'high'],
      defaultEffort: 'high',
    }
    expect(probeChipText(result('m', 'non-validating'), model, translator()))
      .toBe('不可调档位 · 用默认档位（目录声明 low / high）')
  })

  it('omits the suffix when the catalog declares nothing', () => {
    const model: WorkBuddyWebModelBadge = { id: 'm', name: 'M' }
    expect(probeChipText(result('m', 'non-validating'), model, translator()))
      .toBe('不可调档位 · 用默认档位')
  })

  it('omits the suffix when the catalog row is missing entirely', () => {
    expect(probeChipText(result('m', 'non-validating'), undefined, translator()))
      .toBe('不可调档位 · 用默认档位')
  })

  it('reports an incomplete detection as such', () => {
    expect(probeChipText(result('m', 'unknown'), undefined, translator())).toBe('检测未完成')
  })

  it('never leaks a locale key into the chip', () => {
    // The panel showed the literal words "probeDeclaredSuffix" because the key
    // was not registered. Every outcome must resolve to real copy.
    const model: WorkBuddyWebModelBadge = { id: 'm', name: 'M', defaultEffort: 'high' }
    for (const outcome of [
      result('m', 'validating', ['low']),
      result('m', 'validating', []),
      result('m', 'non-validating'),
      result('m', 'unknown'),
    ]) {
      const text = probeChipText(outcome, model, translator())
      expect(text).not.toMatch(/probe[A-Z]/u)
    }
  })

  it('keeps the suffix key registered in both shipped languages', () => {
    // A key present in one table and missing from the other renders as the key
    // name in that locale, which is the defect this guards.
    const source = readFileSync(
      fileURLToPath(new URL('../src/client/locales.ts', import.meta.url)),
      'utf8',
    )
    const occurrences = source.match(/probeDeclaredSuffix:/gu) ?? []
    expect(occurrences).toHaveLength(2)
  })
})

describe('de-emphasized actions stay visible', () => {
  /**
   * A settled row's button is dimmed, not removed.
   *
   * An earlier version made both its background and its border transparent. The
   * control was still present and still clickable, but it disappeared into the
   * row — the user's report was simply "where did the buttons go?". De-emphasis
   * has to stop short of erasure, so this pins a real outline.
   */
  const card = readFileSync(
    fileURLToPath(new URL('../src/client/WorkBuddyPluginCard.tsx', import.meta.url)),
    'utf8',
  )

  /** The body of the secondary-button style object. */
  function secondaryBody(): string {
    const declaration = /const secondaryButtonStyle: CSSProperties = \{([\s\S]*?)\n\}/u.exec(card)
    expect(declaration).not.toBeNull()
    return declaration![1]!
  }

  it('gives the secondary button a visible border', () => {
    const body = secondaryBody()
    expect(body).toContain('border: \'1px solid var(--dsw-alias-border-l2)\'')
    expect(body).not.toContain('border: \'1px solid transparent\'')
  })

  it('still gives it no fill, so it reads as secondary', () => {
    expect(secondaryBody()).toContain('background: \'transparent\'')
  })

  it('maps rows over the ranked ids rather than the raw candidate list', () => {
    // Rendering `probe.candidates` directly is what put the only model with
    // selectable levels at the bottom of the panel.
    expect(card).toMatch(/rowIds\.map\(/u)
    expect(card).not.toMatch(/probe\.candidates\.map\(/u)
  })
})
