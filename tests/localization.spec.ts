import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Guards against untranslated copy reaching a Chinese UI.
 *
 * The plugin's text lives in two places, and only one of them is localized:
 *
 * - `src/client/locales.ts` holds a `zh`/`en` pair, and the host picks by the
 *   UI language — that half is fine by construction.
 * - everything else builds strings inline. Those travel to the panel **verbatim**
 *   and are shown inside a Chinese interface, so whatever language they are
 *   written in is what every user sees.
 *
 * A revision of this bundle shipped the check-in panel with its outcome lines,
 * buttons and error reasons still in English — the panel read as half-translated.
 * These specs fail that way again if it recurs.
 */

const root = fileURLToPath(new URL('..', import.meta.url))

/** Read one source file. */
function source(relative: string): string {
  return readFileSync(`${root}${relative}`, 'utf8')
}

/**
 * The user-facing strings in the check-in panel.
 *
 * Every quoted literal that reads as display copy — a sentence with spaces, or
 * a sentence starting with a capital letter — is collected and checked for a
 * CJK character. Identifier-ish literals (`'useState'`, `'2-digit'`) are
 * excluded by requiring a space or a leading capital plus a lowercase run.
 */
function englishLiterals(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(/(['"`])([^'"`\n]{3,})\1/gu)) {
    const value = match[2]!
    if (/[\u4E00-\u9FFFu]/u.test(value)) continue
    // Only sentences: at least two words separated by a space.
    if (!/^[A-Za-z][A-Za-z,'’-]*(?:\s+[A-Za-z][A-Za-z,'’.:-]*)+$/u.test(value.trim())) continue
    found.push(value.trim())
  }
  return found
}

describe('check-in panel copy is Chinese', () => {
  const panel = source('src/client/BuddyCheckinPanel.tsx')

  it('has no English display strings left', () => {
    // Comments are stripped first: the file documents itself in English on
    // purpose, and only the rendered copy is in scope.
    const code = panel
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/\/\/[^\n]*/gu, '')
    expect(englishLiterals(code)).toEqual([])
  })

  it('renders Chinese outcome copy', () => {
    // Spot-check the four states the panel can show, so a rewrite that keeps
    // the structure but loses the translation still fails here.
    expect(panel).toContain('已签到')
    expect(panel).toContain('App 内今日已签到')
    expect(panel).toContain('失败：')
    expect(panel).toContain('剩余积分：')
  })

  it('renders Chinese chrome', () => {
    expect(panel).toContain('WorkBuddy 签到')
    expect(panel).toContain('本次启动检查：')
    expect(panel).toContain('正在查询…')
    expect(panel).toContain('重试失败账号')
    expect(panel).toContain('aria-label="关闭"')
  })
})

describe('host-side copy that reaches the panel is Chinese', () => {
  const checkin = source('src/checkin.ts')

  it('writes a Chinese notice', () => {
    // Toasted in the corner of a Chinese UI.
    expect(checkin).toContain('已完成今日签到')
    expect(checkin).toContain('个账号成功')
    expect(checkin).not.toContain('daily check-in complete')
    expect(checkin).not.toContain('accounts succeeded')
  })

  it('writes Chinese reasons for an unreadable credential', () => {
    // Shown verbatim in a failed row of the panel.
    expect(checkin).toContain('凭据由旧密钥加密')
    expect(checkin).toContain('请在 WorkBuddy App 里重新登录该账号以恢复')
    expect(checkin).not.toContain('sign in to this account once in the WorkBuddy app')
    expect(checkin).not.toContain('is not in a recognized format')
  })

  it('writes Chinese balance errors', () => {
    expect(checkin).toContain('未找到登录凭据，显示上次记录')
    expect(checkin).toContain('余额查询失败，显示上次记录')
    expect(checkin).not.toContain('no credential found; showing the last record')
    expect(checkin).not.toContain('balance read failed; showing the last record')
  })
})
