import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkBuddyProbeStore } from '../src/probe-store.ts'
import { probeChipText } from '../src/client/probe-rows.ts'
import type { ProbeChipTranslator } from '../src/client/probe-rows.ts'
import type { WorkBuddyWebProbeModel } from '../src/status-paths.ts'

/**
 * Why an inconclusive detection must carry its reason.
 *
 * A probe that cannot conclude answers `unknown`, and `unknown` on its own is
 * a dead end: the user sees "detection did not complete" and can only guess
 * whether the upstream refused the request, the model is broken, or the
 * request never reached the network. The host computes the explanation — the
 * failing stage and the upstream's error code — but it used to die at the
 * process boundary, so the state file and the card could only say "unknown".
 *
 * These specs pin the reason's path: the probe outcome → the stored record →
 * the file on disk → the chip the user reads.
 */

function withTempHome(body: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'buddy-suite-reason-'))
  try {
    body(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

describe('probe record reason', () => {
  it('stores the reason on an unknown observation', () => {
    withTempHome(home => {
      const path = join(home, '.buddy-suite-probe.json')
      const store = new WorkBuddyProbeStore({ path, pluginVersion: '0.1.1' })
      store.set('glm-5.1', store.record(
        'abc123',
        'unknown',
        [],
        'account:',
        'baseline status 400 (invalid_reasoning_effort)',
      ))

      const document = JSON.parse(readFileSync(path, 'utf8'))
      const record = document.records['account:']['glm-5.1']
      expect(record.validation).toBe('unknown')
      expect(record.reason).toBe('baseline status 400 (invalid_reasoning_effort)')
    })
  })

  it('omits the reason when there is none to give', () => {
    withTempHome(home => {
      const path = join(home, '.buddy-suite-probe.json')
      const store = new WorkBuddyProbeStore({ path, pluginVersion: '0.1.1' })
      store.set('hy3', store.record('abc123', 'non-validating', [], 'account:'))

      const document = JSON.parse(readFileSync(path, 'utf8'))
      const record = document.records['account:']['hy3']
      expect(record.reason).toBeUndefined()
      // A decisive observation has nothing to explain, so an empty string is
      // not stored as if it were a reason.
      expect('reason' in record).toBe(false)
    })
  })

  it('drops an empty reason rather than storing a blank one', () => {
    withTempHome(home => {
      const path = join(home, '.buddy-suite-probe.json')
      const store = new WorkBuddyProbeStore({ path, pluginVersion: '0.1.1' })
      store.set('hy3', store.record('abc123', 'unknown', [], 'account:', ''))

      const document = JSON.parse(readFileSync(path, 'utf8'))
      expect(document.records['account:']['hy3'].reason).toBeUndefined()
    })
  })

  it('serves the reason back to a reader', () => {
    withTempHome(home => {
      const path = join(home, '.buddy-suite-probe.json')
      const store = new WorkBuddyProbeStore({ path, pluginVersion: '0.1.1' })
      store.set('glm-5.1', store.record('abc123', 'unknown', [], 'account:', 'transport error: fetch failed'))

      const found = store.get('glm-5.1', 'abc123', 'account:')
      expect(found?.reason).toBe('transport error: fetch failed')
    })
  })

  it('reads a record written before the reason existed', () => {
    // Older files have no `reason` key at all; they must still be accepted,
    // they simply carry no explanation.
    withTempHome(home => {
      const path = join(home, '.buddy-suite-probe.json')
      const store = new WorkBuddyProbeStore({ path, pluginVersion: '0.1.1' })
      store.set('hy3', store.record('abc123', 'non-validating', [], 'account:'))

      const document = JSON.parse(readFileSync(path, 'utf8'))
      delete document.records['account:']['hy3'].reason
      writeFileSync(path, JSON.stringify(document, null, 2))

      const reread = new WorkBuddyProbeStore({ path, pluginVersion: '0.1.1' })
      expect(reread.get('hy3', 'abc123', 'account:')).toMatchObject({ validation: 'non-validating' })
    })
  })

  it('rejects a record whose reason is not a string', () => {
    withTempHome(home => {
      const path = join(home, '.buddy-suite-probe.json')
      const store = new WorkBuddyProbeStore({ path, pluginVersion: '0.1.1' })
      store.set('hy3', store.record('abc123', 'non-validating', [], 'account:'))

      const document = JSON.parse(readFileSync(path, 'utf8'))
      document.records['account:']['hy3'].reason = 42
      writeFileSync(path, JSON.stringify(document, null, 2))

      const reread = new WorkBuddyProbeStore({ path, pluginVersion: '0.1.1' })
      expect(reread.get('hy3', 'abc123', 'account:')).toBeUndefined()
    })
  })

  it('does not let the reason change a record\'s fingerprint', () => {
    // The reason is diagnostic. If it entered the fingerprint, every existing
    // record would be invalidated the moment this field was introduced.
    withTempHome(home => {
      const path = join(home, '.buddy-suite-probe.json')
      const store = new WorkBuddyProbeStore({ path, pluginVersion: '0.1.1' })
      store.set('glm-5.1', store.record('abc123', 'unknown', [], 'account:', 'baseline status 500'))

      const found = store.get('glm-5.1', 'abc123', 'account:')
      expect(found).toBeDefined()
    })
  })
})

describe('probe chip text with a reason', () => {
  const t: ProbeChipTranslator = (key, params) => {
    if (key === 'probeResultUnknown') return '检测未完成'
    if (key === 'probeResultUnknownDiag') return `检测未完成 · ${String(params?.['diagnosis'])}`
    if (key === 'probeResultNotValidating') return '不可调档位 · 用默认档位'
    return '（目录声明）'
  }

  it('shows the diagnosis, not the raw upstream text', () => {
    // The chip is a few words wide: the raw record overflows the row without
    // telling the reader anything they can act on.
    const model: WorkBuddyWebProbeModel = {
      id: 'glm-5.1',
      name: 'GLM-5.1',
      validation: 'unknown',
      efforts: [],
      probedAt: 0,
      reason: 'baseline status 400 (invalid_reasoning_effort)',
    }
    expect(probeChipText(model, undefined, t, '上游不接受这个推理档位'))
      .toBe('检测未完成 · 上游不接受这个推理档位')
  })

  it('falls back to the plain wording when no reason was recorded', () => {
    const model: WorkBuddyWebProbeModel = {
      id: 'glm-5.1',
      name: 'GLM-5.1',
      validation: 'unknown',
      efforts: [],
      probedAt: 0,
    }
    expect(probeChipText(model, undefined, t)).toBe('检测未完成')
  })

  it('keeps the decisive wording unchanged', () => {
    const model: WorkBuddyWebProbeModel = {
      id: 'deepseek-v4-pro',
      name: 'Deepseek-V4-Pro',
      validation: 'validating',
      efforts: ['low', 'high'],
      probedAt: 0,
      reason: 'should not be shown for a decisive result',
    }
    expect(probeChipText(model, undefined, t)).toBe('low / high')
  })
})
