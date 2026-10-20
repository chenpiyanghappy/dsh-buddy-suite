import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WORKBUDDY_PROBE_FILENAME, WorkBuddyProbeStore, workbuddyProbePath } from '../src/probe-store.ts'
import { WORKBUDDY_VARIANTS } from '../src/variants.ts'

/**
 * Probe-state isolation from the upstream dsh-workbuddy-connect bundle.
 *
 * Both bundles talk to the same WorkBuddy endpoint under the same account, and
 * both used to write their reasoning-effort observations to the same file,
 * `~/.dsh/.workbuddy-probe.json`. A probe record is only honoured when the
 * catalog row's fingerprint still matches, and the two bundles' catalog rows
 * differ in a field or two — so each plugin's records failed the other
 * plugin's fingerprint check and were discarded. The visible effect was that a
 * user with both plugins installed could never see a completed probe, and had
 * to spend credits re-probing the same model.
 *
 * These specs pin the separation: this bundle owns its own file, the two
 * variants own two different files, and the upstream's file is neither read
 * nor written.
 */

/** The file the upstream dsh-workbuddy-connect bundle owns. */
const UPSTREAM_CN_FILENAME = '.workbuddy-probe.json'
const UPSTREAM_AI_FILENAME = '.workbuddy-ai-probe.json'

function withTempHome(body: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'buddy-suite-probe-'))
  try {
    body(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

describe('probe state file naming', () => {
  it('does not end the default path with the upstream filename', () => {
    // The default is the CN variant's file, so it must not be the upstream's.
    expect(workbuddyProbePath().endsWith(UPSTREAM_CN_FILENAME)).toBe(false)
    expect(workbuddyProbePath().endsWith(WORKBUDDY_PROBE_FILENAME)).toBe(true)
  })

  it('namespaces the default filename', () => {
    expect(WORKBUDDY_PROBE_FILENAME).toBe('.buddy-suite-probe.json')
  })

  it('gives the two variants two different files', () => {
    const filenames = WORKBUDDY_VARIANTS.map(variant => variant.probeFilename)
    expect(new Set(filenames).size).toBe(filenames.length)
    for (const filename of filenames) {
      expect(filename).not.toBe(UPSTREAM_CN_FILENAME)
      expect(filename).not.toBe(UPSTREAM_AI_FILENAME)
    }
  })

  it('never names an upstream file anywhere in the variant table', () => {
    for (const variant of WORKBUDDY_VARIANTS) {
      expect(variant.probeFilename).not.toContain('workbuddy-probe.json')
      expect(variant.probeFilename).not.toContain('workbuddy-ai-probe.json')
    }
  })
})

describe('probe state isolation from the upstream bundle', () => {
  it('reads an upstream file as empty', () => {
    withTempHome(home => {
      const upstreamPath = join(home, UPSTREAM_CN_FILENAME)
      writeFileSync(upstreamPath, JSON.stringify({
        version: 2,
        records: {
          'account:': {
            'glm-5.1': {
              fingerprint: 'abc123',
              validation: 'validating',
              efforts: ['low', 'medium'],
              probedAtMs: Date.now(),
              pluginVersion: '0.7.9',
              account: 'account:',
            },
          },
        },
      }))
      const upstreamBefore = readFileSync(upstreamPath, 'utf8')

      const store = new WorkBuddyProbeStore({
        path: join(home, '.buddy-suite-probe.json'),
        pluginVersion: '0.1.1',
      })
      // The upstream's record is invisible: the store never opens that file.
      expect(store.get('glm-5.1', 'abc123', 'account:')).toBeUndefined()
      expect(existsSync(join(home, '.buddy-suite-probe.json'))).toBe(false)
      expect(readFileSync(upstreamPath, 'utf8')).toBe(upstreamBefore)
    })
  })

  it('leaves the upstream file untouched when writing its own', () => {
    withTempHome(home => {
      const upstreamPath = join(home, UPSTREAM_CN_FILENAME)
      writeFileSync(upstreamPath, 'upstream content that must not change\n')
      const upstreamBefore = statSync(upstreamPath).mtimeMs

      const store = new WorkBuddyProbeStore({
        path: join(home, '.buddy-suite-probe.json'),
        pluginVersion: '0.1.1',
      })
      store.set('glm-5.1', {
        fingerprint: 'abc123',
        validation: 'validating',
        efforts: ['low', 'medium'],
        probedAtMs: Date.now(),
        pluginVersion: '0.1.1',
        account: 'account:',
      })

      expect(readFileSync(upstreamPath, 'utf8')).toBe('upstream content that must not change\n')
      expect(statSync(upstreamPath).mtimeMs).toBe(upstreamBefore)
      expect(existsSync(join(home, '.buddy-suite-probe.json'))).toBe(true)
    })
  })

  it('keeps its own records readable across a reload', () => {
    withTempHome(home => {
      const path = join(home, '.buddy-suite-probe.json')
      const first = new WorkBuddyProbeStore({ path, pluginVersion: '0.1.1' })
      first.set('glm-5.1', {
        fingerprint: 'abc123',
        validation: 'validating',
        efforts: ['low', 'medium'],
        probedAtMs: Date.now(),
        pluginVersion: '0.1.1',
        account: 'account:',
      })

      const second = new WorkBuddyProbeStore({ path, pluginVersion: '0.1.1' })
      expect(second.get('glm-5.1', 'abc123', 'account:')).toMatchObject({
        validation: 'validating',
        efforts: ['low', 'medium'],
      })
    })
  })
})
