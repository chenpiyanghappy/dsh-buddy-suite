import { afterEach, describe, expect, it } from 'vitest'
import { release } from 'node:os'
import { isWsl } from '../src/wsl.ts'

/**
 * WSL detection.
 *
 * Both the desktop-auth candidate probe and the at-rest key helper consult this,
 * and they must agree on what "WSL" means — a disagreement would have one search
 * the Windows mount while the other spawns a Linux path. The check is guarded by
 * `process.platform`, so the assertions are conditional on the host the suite is
 * running on rather than assuming one. That keeps the file honest on both CI legs.
 */

const ENV_KEYS = ['WSL_DISTRO_NAME', 'WSL_INTEROP'] as const
const saved = new Map<string, string | undefined>()

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  saved.clear()
})

function setWslEnv(): void {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key])
    process.env[key] = 'value'
  }
}

describe('isWsl', () => {
  it('is never true off Linux', () => {
    if (process.platform === 'linux') return
    // WSL is a Linux kernel; a Windows or macOS process cannot be inside it even
    // if the variables leaked into the environment.
    setWslEnv()
    expect(isWsl()).toBe(false)
  })

  it('reports WSL when the environment says so on Linux', () => {
    if (process.platform !== 'linux') return
    setWslEnv()
    expect(isWsl()).toBe(true)
  })

  it('reports not-WSL when a Linux process carries no WSL marker', () => {
    if (process.platform !== 'linux') return
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key])
      delete process.env[key]
    }
    // A stock Linux kernel release string does not contain "microsoft"; if the
    // suite itself runs inside WSL this assertion would be wrong, so the release
    // is consulted rather than assumed.
    if (release().toLowerCase().includes('microsoft')) return
    expect(isWsl()).toBe(false)
  })

  it('accepts either marker variable, not both', () => {
    if (process.platform !== 'linux') return
    saved.set('WSL_INTEROP', process.env['WSL_INTEROP'])
    delete process.env['WSL_INTEROP']
    saved.set('WSL_DISTRO_NAME', process.env['WSL_DISTRO_NAME'])
    process.env['WSL_DISTRO_NAME'] = 'Ubuntu'
    expect(isWsl()).toBe(true)
  })

  it('is a pure predicate with a boolean result', () => {
    expect(typeof isWsl()).toBe('boolean')
  })
})
