import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { REQUIRED_PI_AI_VERSION, piAiVersionWarning, resolvedPiAiVersion } from '../src/pi-ai-guard.ts'

/**
 * The pi-ai generation guard.
 *
 * #92's failure mode was an older pi-ai winning bare-specifier resolution and
 * killing every request with an opaque `PI_AI_ERROR`. The guard exists so a
 * regression names the versions instead of that crash — which only works if the
 * constant it compares against is the generation the plugin is actually built
 * for. A stale constant turns the guard into permanent background noise, which
 * is worse than no guard: it trains readers to ignore the one line that would
 * explain a real breakage.
 */

const VERSION_SHAPE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/u

describe('piAiVersionWarning', () => {
  it('stays silent when the resolved version is the required one', () => {
    expect(piAiVersionWarning(REQUIRED_PI_AI_VERSION)).toBeUndefined()
  })

  it('names both versions when they differ', () => {
    const warning = piAiVersionWarning('0.1.0')
    expect(warning).toBeDefined()
    expect(warning).toContain('0.1.0')
    expect(warning).toContain(REQUIRED_PI_AI_VERSION)
  })

  it('carries an actionable remedy rather than only versions', () => {
    // The reader's next step is the product, not the diff.
    const warning = piAiVersionWarning('0.1.0')
    expect(warning).toMatch(/Reinstalling the plugin/u)
    expect(warning).toMatch(/hoisted/u)
  })

  it('stays silent when the version cannot be determined', () => {
    // An unreadable copy is not evidence of the wrong copy.
    expect(piAiVersionWarning(undefined)).toBeUndefined()
  })

  it('adds no plugin prefix of its own', () => {
    // Callers log it under their own prefix; a second one doubles up.
    const warning = piAiVersionWarning('0.1.0')
    expect(warning?.startsWith('dsh-buddy-suite')).toBe(false)
  })
})

describe('resolvedPiAiVersion', () => {
  it('reads a version out of the live module graph', () => {
    const version = resolvedPiAiVersion()
    expect(version).toBeDefined()
    expect(version).toMatch(VERSION_SHAPE)
  })
})

describe('the required version', () => {
  it('is a bare semver string', () => {
    expect(REQUIRED_PI_AI_VERSION).toMatch(VERSION_SHAPE)
  })

  it('matches the version the package declares as its dependency', () => {
    // A guard that compares against a generation the plugin no longer ships is
    // worse than no guard: it warns on every healthy start, and the warning a
    // real regression needs goes unread. Measured 2026-10-20: the constant said
    // 0.87.1 while package.json (and the upstream plugin) had moved to 1.3.0.
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { dependencies?: Record<string, string> }
    expect(manifest.dependencies?.['@earendil-works/pi-ai']).toBe(REQUIRED_PI_AI_VERSION)
  })
})
