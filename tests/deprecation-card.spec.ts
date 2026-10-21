import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

/**
 * The end-of-life announcement and the tri-state lamp, as shipped copy.
 *
 * There is no browser to render here, so the assertions are on the locale table
 * (the only home of user-facing text) and on the card source (the structure that
 * renders it). That split is the point: the announcement must not live as a
 * hardcoded string in the component, and the lamp must branch on the tri-state
 * health rather than on sign-in state alone.
 */

const root = fileURLToPath(new URL('..', import.meta.url))

/** Read one source file. */
function source(relative: string): string {
  return readFileSync(`${root}${relative}`, 'utf8')
}

const CARD = source('src/client/WorkBuddyPluginCard.tsx')
const ADAPTER = source('src/adapter.ts')

describe('the end-of-life copy', () => {
  it('is declared in both shipped languages', () => {
    for (const key of [
      'deprecationHeading',
      'deprecationFinalVersion',
      'deprecationReality',
      'deprecationNoPromise',
      'deprecationHistory',
      'deprecationThanks',
    ] as const) {
      expect(en[key].length).toBeGreaterThan(0)
      expect(zh[key].length).toBeGreaterThan(0)
    }
  })

  it('states the measured reality, the final release, and the official client', () => {
    // The copy must not soften the finding: real-machine measurement, the
    // 2026-10-20 restriction, "no longer workable", and the official client.
    expect(zh.deprecationHeading).toContain('已停止维护')
    expect(zh.deprecationHeading).toContain('生命末尾')
    expect(zh.deprecationFinalVersion).toContain('{version}')
    expect(zh.deprecationReality).toContain('真机实测')
    expect(zh.deprecationReality).toContain('2026-10-20')
    expect(zh.deprecationReality).toContain('不可行')
    expect(zh.deprecationReality).toContain('dsh-workbuddy-connect')
    expect(zh.deprecationReality).toContain('2026-10-22')
    expect(zh.deprecationNoPromise).toContain('不声称仍可用')
    expect(zh.deprecationNoPromise).toContain('可用的存档替代')
    expect(zh.deprecationNoPromise).toContain('不建议他人继续沿用')
    expect(zh.deprecationNoPromise).toContain('官方 WorkBuddy 客户端')
  })

  it('labels the merged-issue list as history, not as a capability promise', () => {
    expect(zh.deprecationHistory).toContain('历史记录')
    expect(zh.deprecationHistory).toContain('不构成任何能力承诺')
    for (const issue of ['#199', '#186', '#96', '#181', '#168', '#183', '#165', '#180']) {
      expect(zh.deprecationHistory).toContain(issue)
    }
    expect(zh.deprecationHistory).toContain('T1')
    expect(zh.deprecationHistory).toContain('T2')
    expect(zh.deprecationHistory).toContain('T4')
    expect(zh.deprecationThanks).toContain('感谢')
  })

  it('keeps the English copy equally final', () => {
    expect(en.deprecationHeading).toContain('end of its life')
    expect(en.deprecationReality).toContain('no longer workable')
    expect(en.deprecationReality).toContain('2026-10-20')
    expect(en.deprecationNoPromise).toContain('does not claim to remain usable')
    expect(en.deprecationNoPromise).toContain('official WorkBuddy client')
  })

  it('does not promise continued availability', () => {
    for (const copy of [zh.deprecationNoPromise, en.deprecationNoPromise]) {
      expect(copy).not.toMatch(/将继续维护|将继续提供|持续可用|will remain available|keeps working/iu)
    }
  })
})

describe('the card renders the announcement from the locale table', () => {
  it('mounts the notice above the account figures', () => {
    expect(CARD).toContain('function DeprecationNotice')
    expect(CARD).toContain('<DeprecationNotice t={t} />')
    // It sits above the account heading, so the numbers below it cannot be
    // read as "the plugin still works".
    expect(CARD.indexOf('<DeprecationNotice t={t} />')).toBeLessThan(CARD.indexOf(`{t('accountHeading')}`))
  })

  it('pins the archived version as 0.1.3-final', () => {
    expect(CARD).toContain("const DEPRECATION_FINAL_VERSION = '0.1.3-final'")
    expect(CARD).toContain("t('deprecationFinalVersion', { version: DEPRECATION_FINAL_VERSION })")
  })

  it('keeps user-facing announcement text out of the component', () => {
    // The component may name the locale keys only; the copy itself lives in
    // locales.ts, so both languages stay in one place.
    expect(CARD).not.toContain('已停止维护')
    expect(CARD).not.toContain('非官方客户端')
    expect(CARD).not.toContain('感谢每一位用户')
  })
})

describe('the status lamp follows the tri-state health', () => {
  it('colours all three states and the loading fallback', () => {
    expect(CARD).toContain('plugin_ok')
    expect(CARD).toContain('upstream_changed')
    expect(CARD).toContain('credential_invalid')
    // Green / amber / red theme pairs, one per state.
    expect(CARD).toContain('--dsw-alias-state-success-primary')
    expect(CARD).toContain('--dsw-alias-state-warn-primary')
    expect(CARD).toContain('--dsw-alias-state-error-primary')
  })

  it('passes the document health to the lamp and shows the diagnosis as a tooltip', () => {
    expect(CARD).toMatch(/dotStyle\([^)]*status\?\.health/u)
    expect(CARD).toMatch(/healthTooltip\(t, status\?\.health, status\?\.lastError\)/u)
    // The tooltip text is localized, not hardcoded in the component.
    expect(CARD).not.toContain('上游或网络异常')
  })
})

describe('the model picker marks degraded models', () => {
  it('appends a short marker instead of silently serving a dead catalog', () => {
    // The LLM seam has no disabled flag; the name is the only channel the
    // picker renders, so the marker rides it.
    expect(ADAPTER).toContain('function degradationMarker')
    expect(ADAPTER).toContain('⚠ degraded')
    expect(ADAPTER).toContain('⚠ unavailable')
    expect(ADAPTER).toMatch(/lastError\.code/u)
    expect(ADAPTER).toMatch(/withHealthMarker\(/u)
  })
})
