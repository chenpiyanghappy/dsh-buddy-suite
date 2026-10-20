import { describe, expect, it, vi } from 'vitest'
import { legacySettingsOf } from '../src/legacy-settings.ts'

/**
 * Detection of the pre-0.1.7 host settings API.
 *
 * The plugin ships against a host generation that removed `installSection`
 * entirely, so this probe is what keeps the code honest across the generations
 * it may still be loaded on. Getting it wrong in the permissive direction would
 * install a section whose edits can never be persisted; wrong in the restrictive
 * direction silently disables the maximum-context preference.
 *
 * The probe is deliberately structural: `unknown` in, a narrowed view or
 * `undefined` out, with no casts that would hide host drift.
 */

describe('legacySettingsOf', () => {
  it('accepts a service carrying both members', () => {
    const settings = { installSection: () => {}, update: async () => {} }
    expect(legacySettingsOf(settings)).toBe(settings)
  })

  it('rejects a non-object', () => {
    expect(legacySettingsOf(undefined)).toBeUndefined()
    expect(legacySettingsOf(null)).toBeUndefined()
    expect(legacySettingsOf('settings')).toBeUndefined()
    expect(legacySettingsOf(42)).toBeUndefined()
  })

  it('rejects the 0.2.0 forms facade, which has neither member', () => {
    // `describe`/`update`/`mutate` installs no sections at all; `update` alone
    // is not the contract this plugin drives.
    expect(legacySettingsOf({ describe: () => {}, mutate: () => {} })).toBeUndefined()
  })

  it('rejects a service with only installSection', () => {
    // Without `update` the installed section could never be persisted.
    expect(legacySettingsOf({ installSection: () => {} })).toBeUndefined()
  })

  it('rejects a service with only update', () => {
    expect(legacySettingsOf({ update: async () => {} })).toBeUndefined()
  })

  it('rejects members that are present but not callable', () => {
    expect(legacySettingsOf({ installSection: 'yes', update: async () => {} })).toBeUndefined()
    expect(legacySettingsOf({ installSection: () => {}, update: {} })).toBeUndefined()
  })

  it('returns the same object rather than a wrapper', () => {
    // Callers pass the narrowed view straight to the host, so identity matters:
    // a wrapper would detach `this` from the host service.
    const settings = { installSection: () => {}, update: async () => {} }
    expect(legacySettingsOf(settings)).toBe(settings)
  })

  it('does not mutate the service it inspects', () => {
    const settings = { installSection: () => {}, update: async () => {} }
    const before = Object.keys(settings)
    legacySettingsOf(settings)
    expect(Object.keys(settings)).toEqual(before)
  })
})

describe('the legacy contract it narrows to', () => {
  it('hands the section installer the host context it was given', async () => {
    // A minimal end-to-end use of the narrowed API, to prove the two members are
    // callable in the shape the caller expects.
    const installSection = vi.fn()
    const update = vi.fn(async () => {})
    const api = legacySettingsOf({ installSection, update })!

    api.installSection({} as never, 'workbuddy' as never, {} as never, { a: 1 }, {
      setSource: () => {},
      onChange: () => {},
    })
    await api.update('workbuddy' as never, { a: 2 })

    expect(installSection).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith('workbuddy', { a: 2 })
  })
})
