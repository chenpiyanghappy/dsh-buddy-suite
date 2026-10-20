import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkBuddyProbeStore } from '../src/probe-store.ts'
import { WorkBuddyProbeService } from '../src/probe-service.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import type { ProbeSender } from '../src/probe.ts'
import type { WorkBuddyCredentialStore } from '../src/auth.ts'
import type { WorkBuddyUpstreamClient } from '../src/upstream.ts'
import type { WorkBuddyModelInfo } from '../src/catalog.ts'

/**
 * Batch detection ("detect every unfinished model").
 *
 * The panel lists one row per probeable model, and a row that failed leaves a
 * user repeating the same gesture down a long list. The batch does that once —
 * but it spends credit per model, so the properties that matter are the
 * restrained ones: it visits only models still undecided, it asks one model at
 * a time, and it stops when the account it was consented under is no longer the
 * account in effect.
 *
 * Note that a model costs *two* requests to settle as "not adjustable"
 * (baseline, then sentinel), so a per-request log is not a per-model log. The
 * helpers below record model transitions instead.
 */

function catalogOf(...ids: string[]): WorkBuddyCatalog {
  const rows: WorkBuddyModelInfo[] = ids.map(id => ({
    id,
    name: id,
    contextWindow: 8_000,
    maxTokens: 1_000,
    supportsImages: false,
    // Undeclared levels: the only shape detection exists for.
    reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false },
    billing: { free: false },
  }))
  return new WorkBuddyCatalog(rows)
}

async function withStore(body: (store: WorkBuddyProbeStore) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'buddy-suite-batch-'))
  try {
    await body(new WorkBuddyProbeStore({ path: join(home, '.buddy-suite-probe.json'), pluginVersion: '0.1.2' }))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

/** Every attempt is accepted, so a probe settles as "not adjustable". */
const accepted: ProbeSender = async () => ({ status: 200, streamed: true })

function service(options: {
  catalog: WorkBuddyCatalog
  store: WorkBuddyProbeStore
  send: (modelId: string) => ProbeSender
  account?: () => string | undefined
}): WorkBuddyProbeService {
  return new WorkBuddyProbeService({
    store: options.store,
    catalog: options.catalog,
    credentials: { current: async () => ({ accessToken: 't', domain: 'workbuddy.cn' }) } as unknown as WorkBuddyCredentialStore,
    client: {} as unknown as WorkBuddyUpstreamClient,
    consent: () => true,
    account: options.account ?? (() => 'acct:'),
    region: 'cn',
    send: options.send,
  })
}

describe('unresolvedCandidates', () => {
  it('lists models with no decisive observation', async () => {
    await withStore(async store => {
      const svc = service({ catalog: catalogOf('a', 'b', 'c'), store, send: () => accepted })
      expect(svc.unresolvedCandidates()).toEqual(['a', 'b', 'c'])
    })
  })

  it('drops a model that already has a decisive answer', async () => {
    await withStore(async store => {
      const svc = service({ catalog: catalogOf('a', 'b'), store, send: () => accepted })
      await svc.probe('a', true)
      // `a` is settled, so a batch must not spend credit re-learning it.
      expect(svc.unresolvedCandidates()).toEqual(['b'])
    })
  })

  it('keeps a model whose last answer was inconclusive', async () => {
    await withStore(async store => {
      const failing: ProbeSender = async () => ({ status: 500, streamed: false, errorCode: 'boom' })
      const svc = service({ catalog: catalogOf('a'), store, send: () => failing })
      await svc.probe('a', true)
      // `unknown` is not a decision: the model stays on the work list.
      expect(svc.unresolvedCandidates()).toEqual(['a'])
    })
  })

  it('returns nothing while signed out', async () => {
    await withStore(async store => {
      const svc = service({ catalog: catalogOf('a'), store, send: () => accepted, account: () => undefined })
      expect(svc.unresolvedCandidates()).toEqual([])
    })
  })
})

describe('probeMany', () => {
  it('visits every model in order', async () => {
    await withStore(async store => {
      const visited: string[] = []
      const svc = service({
        catalog: catalogOf('a', 'b', 'c'),
        store,
        send: modelId => async () => {
          if (visited[visited.length - 1] !== modelId) visited.push(modelId)
          return { status: 200, streamed: true }
        },
      })

      const results = await svc.probeMany(['a', 'b', 'c'], true)

      expect(visited).toEqual(['a', 'b', 'c'])
      expect(results.map(entry => entry.modelId)).toEqual(['a', 'b', 'c'])
      expect(results.every(entry => entry.status.state === 'ok')).toBe(true)
    })
  })

  it('reports progress while it runs and clears it afterwards', async () => {
    await withStore(async store => {
      const snapshots: ({ done: number, total: number } | undefined)[] = []
      const visited: string[] = []
      let svc: WorkBuddyProbeService
      svc = service({
        catalog: catalogOf('a', 'b'),
        store,
        send: modelId => async () => {
          // Sample once per model, not once per request: a model settles over
          // two requests and only the first one starts its turn.
          if (visited[visited.length - 1] !== modelId) {
            visited.push(modelId)
            snapshots.push(svc.progress())
          }
          return { status: 200, streamed: true }
        },
      })

      await svc.probeMany(['a', 'b'], true)

      // Reported from inside the run, so the panel can say "1 of 2".
      expect(snapshots).toEqual([{ done: 0, total: 2 }, { done: 1, total: 2 }])
      expect(svc.progress()).toBeUndefined()
      expect(svc.isRunning()).toBe(false)
    })
  })

  it('keeps running true for the whole batch', async () => {
    await withStore(async store => {
      const running: boolean[] = []
      let svc: WorkBuddyProbeService
      svc = service({
        catalog: catalogOf('a', 'b'),
        store,
        send: () => async () => {
          running.push(svc.isRunning())
          return { status: 200, streamed: true }
        },
      })

      await svc.probeMany(['a', 'b'], true)

      // The flag must not drop between models, or the card stops watching and
      // the sweep looks stuck for the whole run.
      expect(running.length).toBeGreaterThan(0)
      expect(running.every(value => value)).toBe(true)
    })
  })

  it('continues after a model fails', async () => {
    await withStore(async store => {
      const visited: string[] = []
      const svc = service({
        catalog: catalogOf('a', 'b'),
        store,
        send: modelId => async () => {
          if (visited[visited.length - 1] !== modelId) visited.push(modelId)
          return modelId === 'a'
            ? { status: 500, streamed: false, errorCode: 'boom' }
            : { status: 200, streamed: true }
        },
      })

      const results = await svc.probeMany(['a', 'b'], true)

      expect(visited).toEqual(['a', 'b'])
      expect(results[0]!.status.state).toBe('unavailable')
      expect(results[1]!.status.state).toBe('ok')
    })
  })

  it('stops when the account changes under it', async () => {
    await withStore(async store => {
      let account: string | undefined = 'acct:'
      const visited: string[] = []
      const svc = service({
        catalog: catalogOf('a', 'b', 'c'),
        store,
        account: () => account,
        send: modelId => async () => {
          if (visited[visited.length - 1] !== modelId) visited.push(modelId)
          // The user switches account while the first model is in flight.
          account = 'other:'
          return { status: 200, streamed: true }
        },
      })

      const results = await svc.probeMany(['a', 'b', 'c'], true)

      expect(visited).toEqual(['a'])
      expect(results).toHaveLength(1)
    })
  })

  it('asks one model at a time', async () => {
    await withStore(async store => {
      let inFlight = 0
      let maxInFlight = 0
      const svc = service({
        catalog: catalogOf('a', 'b'),
        store,
        send: () => async () => {
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          await new Promise(done => setTimeout(done, 1))
          inFlight -= 1
          return { status: 200, streamed: true }
        },
      })

      await svc.probeMany(['a', 'b'], true)

      // Serial by construction: a batch must never contend with a real chat or
      // with itself.
      expect(maxInFlight).toBe(1)
    })
  })
})
