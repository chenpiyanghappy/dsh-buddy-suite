import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUDDY_CHECKIN_FILENAME } from '../src/state-paths.ts'
import { WORKBUDDY_PROBE_FILENAME, workbuddyProbePath } from '../src/probe-store.ts'
import { WORKBUDDY_CATALOG_FILENAME, workbuddyCatalogPath } from '../src/catalog-store.ts'
import { WORKBUDDY_VISIBILITY_FILENAME, workbuddyVisibilityPath } from '../src/visibility-store.ts'
import { WORKBUDDY_AUTH_FILENAME, workbuddyOwnAuthPath } from '../src/auth.ts'
import { WORKBUDDY_HOST_HEARTBEAT_FILENAME, workbuddyHostHeartbeatPath } from '../src/host-heartbeat.ts'
import { CN_APP_VERSION_FILENAME } from '../src/client-identity.ts'
import { WORKBUDDY_APP_VERSION_FILENAME, appVersionPath } from '../src/app-version.ts'
import { WORKBUDDY_VARIANTS } from '../src/variants.ts'

/**
 * The plugin's state-file names and where they live.
 *
 * Two of these are isolation red lines against `dsh-workbuddy-connect`: the probe
 * file and its international twin. Sharing either let one plugin void the other's
 * paid-for observations, so the names are asserted rather than merely used.
 *
 * `$DSH_HOME` is overridden per test with a temp directory, which also proves the
 * override is honoured — a plugin that ignored it would write into the user's
 * real home during the suite.
 */

const ORIGINAL_DSH_HOME = process.env['DSH_HOME']
let home: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'buddy-suite-paths-'))
  process.env['DSH_HOME'] = home
})

afterEach(() => {
  if (ORIGINAL_DSH_HOME === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = ORIGINAL_DSH_HOME
  if (home !== undefined) rmSync(home, { recursive: true, force: true })
  home = undefined
})

describe('state file names', () => {
  it('keeps the check-in file name', () => {
    expect(BUDDY_CHECKIN_FILENAME).toBe('.buddy-checkin.json')
  })

  it('names the two probe files apart and away from the upstream bundle', () => {
    // The isolation red line: the upstream plugin owns `.workbuddy-probe.json`
    // and `.workbuddy-ai-probe.json`, and sharing them made each plugin discard
    // the other's observations.
    const filenames = WORKBUDDY_VARIANTS.map(variant => variant.probeFilename)
    expect(filenames).toEqual(['.buddy-suite-probe.json', '.buddy-suite-ai-probe.json'])
    expect(filenames).not.toContain('.workbuddy-probe.json')
    expect(filenames).not.toContain('.workbuddy-ai-probe.json')
    expect(new Set(filenames).size).toBe(2)
  })

  it('keeps every plugin-owned file name distinct', () => {
    const names = [
      BUDDY_CHECKIN_FILENAME,
      WORKBUDDY_PROBE_FILENAME,
      WORKBUDDY_CATALOG_FILENAME,
      WORKBUDDY_VISIBILITY_FILENAME,
      WORKBUDDY_AUTH_FILENAME,
      WORKBUDDY_HOST_HEARTBEAT_FILENAME,
      CN_APP_VERSION_FILENAME,
      WORKBUDDY_APP_VERSION_FILENAME,
    ]
    expect(new Set(names).size).toBe(names.length)
  })

  it('keeps the two version caches apart', () => {
    // A CN version written into the international cache would relabel that
    // catalog request's User-Agent.
    expect(CN_APP_VERSION_FILENAME).toBe('.workbuddy-app-version.json')
    expect(WORKBUDDY_APP_VERSION_FILENAME).toBe('.workbuddy-ai-version.json')
  })
})

describe('$DSH_HOME handling', () => {
  it('honours the override for every state path', () => {
    const paths = [
      workbuddyProbePath(),
      workbuddyCatalogPath(),
      workbuddyVisibilityPath(),
      workbuddyOwnAuthPath(),
      workbuddyHostHeartbeatPath(),
      appVersionPath(),
    ]
    for (const path of paths) {
      expect(path.startsWith(home!)).toBe(true)
    }
  })

  it('builds the probe path from the variant filename', () => {
    expect(workbuddyProbePath(WORKBUDDY_VARIANTS[0]!.probeFilename))
      .toBe(join(home!, '.buddy-suite-probe.json'))
    expect(workbuddyProbePath(WORKBUDDY_VARIANTS[1]!.probeFilename))
      .toBe(join(home!, '.buddy-suite-ai-probe.json'))
  })

  it('falls back to a directory of its own choosing when the override is blank', () => {
    // A blank value must not resolve to the filesystem root.
    process.env['DSH_HOME'] = '   '
    const path = workbuddyProbePath()
    expect(path.endsWith(WORKBUDDY_PROBE_FILENAME)).toBe(true)
    expect(path.length).toBeGreaterThan(WORKBUDDY_PROBE_FILENAME.length + 1)
  })

  it('resolves the default home when the override is removed', () => {
    delete process.env['DSH_HOME']
    const path = workbuddyCatalogPath()
    expect(path.endsWith(WORKBUDDY_CATALOG_FILENAME)).toBe(true)
    expect(path.startsWith(home!)).toBe(false)
  })
})
