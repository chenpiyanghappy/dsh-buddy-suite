import { describe, expect, it } from 'vitest'
import { WORKBUDDY_PROVIDER, WORKBUDDY_STREAM_IDLE_TIMEOUT_MS, reasoningFields } from '../src/adapter.ts'
import type { WorkBuddyModelInfo } from '../src/catalog.ts'
import type { WorkBuddyProbeRecord } from '../src/probe-store.ts'

/**
 * The reasoning descriptor the adapter hands pi-ai.
 *
 * This is the whole "thinking control" contract: which levels the picker offers,
 * and therefore what reaches the wire. Three rules interact and each has bitten
 * in production:
 *
 * 1. a declared set always wins over an observation;
 * 2. an observation may only supply a set when it is `validating` — a
 *    non-validating or unknown observation must not produce levels;
 * 3. `off` needs both `canDisableThinking` *and* not `onlyReasoning` on CN,
 *    because that endpoint answers HTTP 400 for `off` on a model that only ever
 *    reasons, and offering a level certain to fail is worse than omitting it.
 *
 * Only pure functions are exercised; the adapter's network layer is out of scope
 * for this suite.
 */

function model(overrides: Partial<WorkBuddyModelInfo> = {}): WorkBuddyModelInfo {
  return {
    id: 'm',
    name: 'M',
    contextWindow: 1000,
    maxTokens: 100,
    supportsImages: false,
    reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false },
    billing: { free: false },
    ...overrides,
  }
}

function observation(overrides: Partial<WorkBuddyProbeRecord> = {}): WorkBuddyProbeRecord {
  return {
    fingerprint: 'fp',
    validation: 'validating',
    efforts: ['low', 'high'],
    probedAtMs: 1,
    pluginVersion: '0.1.2',
    account: 'account:',
    ...overrides,
  }
}

/**
 * A row that carries no `reasoning` block at all.
 *
 * Built by deletion rather than by passing `undefined`: the project compiles with
 * `exactOptionalPropertyTypes`, where an explicit `undefined` is not the same
 * thing as an absent property, and "the catalog did not mention reasoning" is
 * exactly the absent case.
 */
function modelWithoutReasoning(): WorkBuddyModelInfo {
  const copy: Partial<WorkBuddyModelInfo> = { ...model() }
  delete copy.reasoning
  return copy as WorkBuddyModelInfo
}

describe('reasoningFields for a model without reasoning', () => {
  it('reports no reasoning when the catalog omits the block', () => {
    expect(reasoningFields(modelWithoutReasoning())).toEqual({ reasoning: false })
  })

  it('reports no reasoning when the catalog says supports is false', () => {
    const info = model({
      reasoning: { supports: false, onlyReasoning: false, canDisableThinking: true },
    })
    expect(reasoningFields(info)).toEqual({ reasoning: false })
  })

  it('ignores an observation for a model that does not reason', () => {
    const info = model({ reasoning: { supports: false, onlyReasoning: false, canDisableThinking: true } })
    expect(reasoningFields(info, observation())).toEqual({ reasoning: false })
  })
})

describe('declared effort sets', () => {
  it('maps every declared level', () => {
    const info = model({
      reasoning: {
        supports: true,
        onlyReasoning: true,
        supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: 'medium',
        canDisableThinking: false,
      },
    })
    const fields = reasoningFields(info)

    expect(fields.reasoning).toBe(true)
    expect(fields.thinkingLevelMap).toMatchObject({
      low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
    })
  })

  it('leaves undeclared levels null', () => {
    const info = model({
      reasoning: {
        supports: true,
        onlyReasoning: true,
        supportedEfforts: ['low', 'high'],
        defaultEffort: 'high',
        canDisableThinking: false,
      },
    })
    const map = reasoningFields(info).thinkingLevelMap

    expect(map).toMatchObject({ low: 'low', high: 'high', medium: null, xhigh: null, max: null })
  })

  it('never grants minimal', () => {
    // `minimal` is outside the upstream effort vocabulary, so no declaration can
    // contain it.
    const info = model({
      reasoning: {
        supports: true,
        onlyReasoning: true,
        supportedEfforts: ['low', 'high'],
        defaultEffort: 'high',
        canDisableThinking: false,
      },
    })
    expect(reasoningFields(info).thinkingLevelMap?.minimal).toBeNull()
  })

  it('wins over an observation', () => {
    const info = model({
      reasoning: {
        supports: true,
        onlyReasoning: true,
        supportedEfforts: ['high'],
        defaultEffort: 'high',
        canDisableThinking: false,
      },
    })
    const map = reasoningFields(info, observation({ efforts: ['low', 'max'] })).thinkingLevelMap

    expect(map).toMatchObject({ high: 'high', low: null, max: null })
  })
})

describe('observed effort sets', () => {
  it('uses a validating observation for an undeclared row', () => {
    const map = reasoningFields(model(), observation({ efforts: ['low', 'high'] })).thinkingLevelMap
    expect(map).toMatchObject({ low: 'low', high: 'high', medium: null })
  })

  it('refuses a non-validating observation', () => {
    // The upstream accepted a bogus value, so no per-level answer is meaningful.
    const fields = reasoningFields(model(), observation({ validation: 'non-validating', efforts: [] }))
    expect(fields).toEqual({ reasoning: false })
  })

  it('refuses an unknown observation', () => {
    const fields = reasoningFields(model(), observation({ validation: 'unknown', efforts: [] }))
    expect(fields).toEqual({ reasoning: false })
  })

  it('refuses a validating observation that recorded no levels', () => {
    const fields = reasoningFields(model(), observation({ efforts: [] }))
    expect(fields).toEqual({ reasoning: false })
  })

  it('reports no reasoning when undeclared and unobserved', () => {
    expect(reasoningFields(model())).toEqual({ reasoning: false })
  })

  it('treats an empty declared list as undeclared', () => {
    const info = model({
      reasoning: {
        supports: true,
        onlyReasoning: true,
        supportedEfforts: [],
        defaultEffort: 'medium',
        canDisableThinking: false,
      },
    })
    // Falls through to the observation, which supplies the levels.
    expect(reasoningFields(info, observation({ efforts: ['high'] })).thinkingLevelMap)
      .toMatchObject({ high: 'high' })
  })
})

describe('the off level', () => {
  const withEfforts = (canDisableThinking: boolean, onlyReasoning: boolean): WorkBuddyModelInfo => model({
    reasoning: {
      supports: true,
      onlyReasoning,
      supportedEfforts: ['low', 'high'],
      defaultEffort: 'high',
      canDisableThinking,
    },
  })

  it('is offered when the catalog allows disabling thinking', () => {
    const map = reasoningFields(withEfforts(true, false), undefined, 'global').thinkingLevelMap
    expect(map?.off).toBe('off')
  })

  it('is withheld when canDisableThinking is false', () => {
    const map = reasoningFields(withEfforts(false, false)).thinkingLevelMap
    expect(map?.off).toBeNull()
  })

  it('is withheld on CN for an only-reasoning model even when declared', () => {
    // #87: the CN catalog ships both flags true and the endpoint answers 400 for
    // `off` on those models. The wire agrees with `onlyReasoning`.
    const map = reasoningFields(withEfforts(true, true), undefined, 'cn').thinkingLevelMap
    expect(map?.off).toBeNull()
  })

  it('is still offered on the international endpoint for the same row', () => {
    // Scoped to CN on purpose: hiding Off there would remove a usable level.
    const map = reasoningFields(withEfforts(true, true), undefined, 'global').thinkingLevelMap
    expect(map?.off).toBe('off')
  })

  it('is never granted from an observation', () => {
    // Probing measures accepted effort spellings, not the ability to disable
    // thinking, which only a declaration can grant.
    const info = model({
      reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: true },
    })
    const map = reasoningFields(info, observation({ efforts: ['low', 'high'] })).thinkingLevelMap
    expect(map?.off).toBeNull()
  })
})

describe('adapter constants', () => {
  it('registers under the namespaced provider id', () => {
    // The bare `workbuddy` belongs to the upstream bundle; sharing it made one
    // plugin silently replace the other in the model registry.
    expect(WORKBUDDY_PROVIDER).toBe('workbuddy-suite')
    expect(WORKBUDDY_PROVIDER).not.toBe('workbuddy')
  })

  it('carries a generous stream idle timeout', () => {
    // A long reasoning turn must not be cut off mid-stream.
    expect(WORKBUDDY_STREAM_IDLE_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000)
  })
})
