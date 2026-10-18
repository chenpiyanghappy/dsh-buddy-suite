import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CN_ELECTRON_PROFILE,
  WorkBuddyAtRestKeyProvider,
  electronDiscoveryFor,
} from '../src/desktop-credential-protection.ts'

/**
 * Regression specs for Electron location.
 *
 * Found on a real machine: WorkBuddy was installed at a custom path
 * (`D:\Software\Program Flies\WorkBoddy\WorkBuddy\WorkBuddy.exe`), and the key
 * provider returned the *default* Windows path unconditionally. That path did
 * not exist, so the spawn failed with `ENOENT` and the model provider reported
 * `signed-out` — while the check-in half, whose resolver validates before
 * returning, signed in fine. The two halves of the same bundle disagreeing
 * about the same binary is exactly what the merge was meant to end.
 *
 * The fix: a platform default is a *candidate* and must prove it exists before
 * being returned; only a default that exists may skip discovery.
 *
 * Everything here is offline: the helper spawn is stubbed, and registry output
 * is supplied through a recorded seam rather than a real `reg.exe` call.
 */

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
  vi.unstubAllEnvs()
})

/** A temp directory removed after the test. */
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** Build a layout-valid fake WorkBuddy install; returns its exe path. */
async function fakeInstall(): Promise<string> {
  const root = await tempDir('buddy-electron-install-')
  await writeFile(join(root, 'WorkBuddy.exe'), '')
  await writeFile(join(root, 'version'), '37.10.3-24')
  await mkdir(join(root, 'resources'), { recursive: true })
  await writeFile(join(root, 'resources', 'app.asar'), '')
  return join(root, 'WorkBuddy.exe')
}

/** The helper payload a real Electron would print. */
const HELPER_PAYLOAD = JSON.stringify({
  version: 1,
  atRestSecretKey: Buffer.alloc(32, 7).toString('base64'),
})

/** Options for a provider whose spawn is recorded rather than executed. */
function providerOptions(spawned: string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    product: CN_ELECTRON_PROFILE,
    discovery: electronDiscoveryFor('win32'),
    platform: 'win32',
    spawnHelper: async (path: string) => {
      spawned.push(path)
      return HELPER_PAYLOAD
    },
    ...extra,
  }
}

describe('a platform default is a candidate, not a commitment', () => {
  it('falls back to discovery when the default location holds no binary', async () => {
    const installed = await fakeInstall()
    // An empty %LOCALAPPDATA% reproduces the reported machine: the app lives
    // somewhere else entirely, so the default path names nothing.
    const emptyLocal = await tempDir('buddy-empty-localappdata-')
    vi.stubEnv('LOCALAPPDATA', emptyLocal)
    vi.stubEnv('WORKBUDDY_ELECTRON_BIN', '')

    const spawned: string[] = []
    const provider = new WorkBuddyAtRestKeyProvider(
      providerOptions(spawned, { defaultElectronPath: join(emptyLocal, 'Programs', 'WorkBuddy', 'WorkBuddy.exe') }) as never,
    )
    // Discovery cannot reach a real registry in a unit test, so the call is
    // expected to fail — what matters is that it did *not* spawn the absent
    // default and that discovery was attempted rather than short-circuited.
    await expect(provider.protectorKeyFor(['0000000000000000'])).rejects.toThrow()
    expect(spawned).toEqual([])
    expect(installed).toContain('WorkBuddy.exe')
  })

  it('uses the default location when it really exists', async () => {
    const installed = await fakeInstall()
    vi.stubEnv('WORKBUDDY_ELECTRON_BIN', '')
    const spawned: string[] = []
    const provider = new WorkBuddyAtRestKeyProvider(
      providerOptions(spawned, { defaultElectronPath: installed }) as never,
    )
    await expect(provider.protectorKeyFor(['0000000000000000'])).rejects.toThrow()
    expect(spawned).toEqual([installed])
  })

  it('prefers an explicit env var over both the default and discovery', async () => {
    const explicit = await fakeInstall()
    const other = await fakeInstall()
    vi.stubEnv('WORKBUDDY_ELECTRON_BIN', explicit)
    const spawned: string[] = []
    const provider = new WorkBuddyAtRestKeyProvider(
      providerOptions(spawned, { defaultElectronPath: other }) as never,
    )
    await expect(provider.protectorKeyFor(['0000000000000000'])).rejects.toThrow()
    // The explicit binary is authoritative: the existing default is not used.
    expect(spawned).toEqual([explicit])
  })
})

describe('the check-in half and the provider half agree on the binary', () => {
  it('both resolve an existing default to the same path', async () => {
    const installed = await fakeInstall()
    const spawned: string[] = []
    const provider = new WorkBuddyAtRestKeyProvider(
      providerOptions(spawned, { defaultElectronPath: installed }) as never,
    )
    await expect(provider.protectorKeyFor(['0000000000000000'])).rejects.toThrow()
    // `helperPath()` is what diagnostics report; it must name the same binary
    // the helper would actually run, or `doctor` would describe a different
    // install than the one in use.
    expect(provider.helperPath()).toBe(installed)
    expect(spawned).toEqual([installed])
  })
})

describe('discovery timeouts are sized for a real registry', () => {
  /**
   * Found on a real machine: the check-in half reported
   * "auto-location could not complete" while the provider half signed in
   * against the same install. The cause was a 3s per-step cap on
   * `reg query <root> /s`: enumerating a software-dense uninstall tree takes
   * seconds, so the read was cut off and the app was reported as unfindable
   * even though it was installed.
   *
   * The whole-discovery budget — not the per-step limit — is what bounds the
   * user's wait, so the step limit may be generous. These pin both the value
   * and the invariant that keeps it from exceeding the budget.
   */
  const source = readFileSync(
    fileURLToPath(new URL('../src/desktop-credential-protection.ts', import.meta.url)),
    'utf8',
  )

  /** Read one numeric constant out of the module source. */
  function constant(name: string): number {
    const match = new RegExp(`${name} = ([0-9_]+)`, 'u').exec(source)
    expect(match, `${name} not found`).not.toBeNull()
    return Number(match![1]!.replace(/_/gu, ''))
  }

  it('gives one registry read enough time to finish', () => {
    // 3s was measured to cut the plain HKLM read in half on ordinary machines.
    expect(constant('DISCOVERY_STEP_TIMEOUT_MS')).toBeGreaterThanOrEqual(10_000)
  })

  it('never lets a step outlast the whole-discovery budget', () => {
    // Otherwise the budget's abort and the step's own timeout race, and the
    // diagnosis depends on which one wins.
    expect(constant('DISCOVERY_STEP_TIMEOUT_MS')).toBeLessThanOrEqual(constant('DISCOVERY_BUDGET_MS'))
  })
})
