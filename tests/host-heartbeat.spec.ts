import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  WORKBUDDY_HOST_HEARTBEAT_FILENAME,
  clearHostHeartbeat,
  isHeartbeatProcessAlive,
  parseWmiCreationDate,
  processStartTimeMs,
  readHostHeartbeat,
  workbuddyHostHeartbeatPath,
  writeHostHeartbeat,
} from '../src/host-heartbeat.ts'

/**
 * The host heartbeat.
 *
 * It answers one question for the CLI status: is the host bundle that owns this
 * profile still running? A stale file left by a crashed host must read as dead,
 * which is why the reader compares the process start time against the recorded
 * registration time instead of trusting PID existence alone — the OS recycles
 * PIDs.
 *
 * `$DSH_HOME` is pointed at a temp directory so the suite never touches the
 * user's real home, and so the path handling is exercised rather than assumed.
 */

const ORIGINAL_DSH_HOME = process.env['DSH_HOME']
let home: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'buddy-suite-heartbeat-'))
  process.env['DSH_HOME'] = home
})

afterEach(() => {
  if (ORIGINAL_DSH_HOME === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = ORIGINAL_DSH_HOME
  if (home !== undefined) rmSync(home, { recursive: true, force: true })
  home = undefined
})

describe('heartbeat file', () => {
  it('lives under the Harness home with its documented name', () => {
    expect(WORKBUDDY_HOST_HEARTBEAT_FILENAME).toBe('.workbuddy-host-heartbeat.json')
    expect(workbuddyHostHeartbeatPath()).toBe(join(home!, WORKBUDDY_HOST_HEARTBEAT_FILENAME))
  })

  it('reads as absent before anything wrote it', async () => {
    await expect(readHostHeartbeat()).resolves.toBeUndefined()
  })

  it('round-trips what the host wrote', async () => {
    await writeHostHeartbeat()
    const heartbeat = await readHostHeartbeat()

    expect(heartbeat?.package).toBe('dsh-buddy-suite')
    expect(heartbeat?.pid).toBe(process.pid)
    expect(typeof heartbeat?.registeredAt).toBe('number')
    expect(typeof heartbeat?.pluginVersion).toBe('string')
  })

  it('overwrites a previous heartbeat rather than appending', async () => {
    await writeHostHeartbeat()
    const first = await readHostHeartbeat()
    await writeHostHeartbeat()
    const second = await readHostHeartbeat()

    expect(second?.pid).toBe(first?.pid)
    expect(second?.registeredAt).toBeGreaterThanOrEqual(first!.registeredAt)
  })

  it('clears the file on disposal', async () => {
    await writeHostHeartbeat()
    await clearHostHeartbeat()
    expect(existsSync(workbuddyHostHeartbeatPath())).toBe(false)
  })

  it('tolerates clearing when nothing was written', async () => {
    await expect(clearHostHeartbeat()).resolves.toBeUndefined()
  })
})

describe('heartbeat validation', () => {
  function write(text: string): void {
    writeFileSync(workbuddyHostHeartbeatPath(), text)
  }

  it('rejects malformed JSON', async () => {
    write('{oops')
    await expect(readHostHeartbeat()).resolves.toBeUndefined()
  })

  it('rejects a document of another version', async () => {
    write(JSON.stringify({ version: 99, package: 'dsh-buddy-suite', registeredAt: 1, pid: 1 }))
    await expect(readHostHeartbeat()).resolves.toBeUndefined()
  })

  it('rejects a document from another package', async () => {
    // A different plugin's heartbeat must never be read as this plugin's host.
    write(JSON.stringify({ version: 1, package: 'dsh-workbuddy-connect', registeredAt: 1, pid: 1 }))
    await expect(readHostHeartbeat()).resolves.toBeUndefined()
  })

  it('rejects a document missing the registration time or pid', async () => {
    write(JSON.stringify({ version: 1, package: 'dsh-buddy-suite', pid: 1 }))
    await expect(readHostHeartbeat()).resolves.toBeUndefined()
    write(JSON.stringify({ version: 1, package: 'dsh-buddy-suite', registeredAt: 1 }))
    await expect(readHostHeartbeat()).resolves.toBeUndefined()
  })

  it('replaces a missing plugin version with a placeholder rather than failing', async () => {
    write(JSON.stringify({ version: 1, package: 'dsh-buddy-suite', registeredAt: 1, pid: 1 }))
    await expect(readHostHeartbeat()).resolves.toMatchObject({ pluginVersion: 'unknown' })
  })
})

describe('parseWmiCreationDate', () => {
  it('subtracts a positive UTC offset', () => {
    // `+480` means local time is 480 minutes ahead of UTC: 10:43:14 local is
    // 02:43:14Z.
    const parsed = parseWmiCreationDate('20260923104314.239907+480')
    expect(parsed).toBe(Date.UTC(2026, 8, 23, 2, 43, 14))
  })

  it('adds a negative UTC offset', () => {
    const parsed = parseWmiCreationDate('20260923104314.000000-300')
    expect(parsed).toBe(Date.UTC(2026, 8, 23, 15, 43, 14))
  })

  it('treats a zero offset as UTC', () => {
    expect(parseWmiCreationDate('20260101000000.000000+000')).toBe(Date.UTC(2026, 0, 1, 0, 0, 0))
  })

  it('rejects a four-digit offset instead of partially matching it', () => {
    // The format has three signed digits; `+4800` is not a valid value and must
    // not be truncated to `+480`.
    expect(parseWmiCreationDate('20260923104314.239907+4800')).toBeUndefined()
  })

  it('rejects out-of-range fields rather than letting Date roll them over', () => {
    expect(parseWmiCreationDate('20261323104314.000000+000')).toBeUndefined()
    expect(parseWmiCreationDate('20260932104314.000000+000')).toBeUndefined()
    expect(parseWmiCreationDate('20260923244314.000000+000')).toBeUndefined()
    expect(parseWmiCreationDate('20260923106014.000000+000')).toBeUndefined()
    expect(parseWmiCreationDate('20260923104360.000000+000')).toBeUndefined()
  })

  it('rejects anything not shaped like CIM_DATETIME', () => {
    expect(parseWmiCreationDate('')).toBeUndefined()
    expect(parseWmiCreationDate('2026-09-23T10:43:14Z')).toBeUndefined()
    expect(parseWmiCreationDate('20260923104314.239907')).toBeUndefined()
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseWmiCreationDate('  20260101000000.000000+000  ')).toBe(Date.UTC(2026, 0, 1, 0, 0, 0))
  })
})

describe('isHeartbeatProcessAlive', () => {
  /** A complete heartbeat for one pid, dated at `registeredAt`. */
  function heartbeat(pid: number, registeredAt: number) {
    return {
      version: 1 as const,
      package: 'dsh-buddy-suite' as const,
      pluginVersion: '0.1.2',
      registeredAt,
      pid,
    }
  }

  it('reports this process as alive when it registered just now', () => {
    expect(isHeartbeatProcessAlive(heartbeat(process.pid, Date.now()))).toBe(true)
  })

  it('reports a missing pid as dead', () => {
    // A PID far outside any real range is the portable way to say "no such
    // process" without depending on platform limits.
    expect(isHeartbeatProcessAlive(heartbeat(999_999_999, Date.now()))).toBe(false)
  })

  it('compares start time against the registration time when the platform allows', () => {
    // A heartbeat dated before the epoch can only have been written by a process
    // that has since exited, so a PID recycled onto a newer process must read
    // dead. When the platform cannot read a start time the documented contract
    // is to degrade to plain PID liveness — which is what the assertion below
    // encodes rather than pretending the stronger check always runs.
    //
    // Measured 2026-10-20 on Windows 11: `wmic` is absent from current builds, so
    // this branch is the one that actually runs there and the recycled-PID
    // protection is inert. See KNOWN-ISSUES.md.
    const alive = isHeartbeatProcessAlive(heartbeat(process.pid, 0))
    if (processStartTimeMs(process.pid) === undefined) {
      expect(alive).toBe(true)
    } else {
      expect(alive).toBe(false)
    }
  })
})

describe('processStartTimeMs', () => {
  it('reports nothing for a process that does not exist', () => {
    expect(processStartTimeMs(999_999_999)).toBeUndefined()
  })

  it('returns either a plausible timestamp or undefined, never throws', () => {
    const start = processStartTimeMs(process.pid)
    if (start !== undefined) {
      // The suite's own process started after 2020 and is not in the future.
      expect(start).toBeGreaterThan(Date.UTC(2020, 0, 1))
      expect(start).toBeLessThanOrEqual(Date.now() + 60_000)
    }
  })
})
