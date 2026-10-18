/**
 * Check the reasoning-probe copy in both languages.
 *
 * There is no browser to screenshot here, so this asserts the *strings* the
 * three `non-validating` surfaces produce, straight out of the locale source.
 * That is the exact regression the wording change is about: the old copy named
 * neither the parameter nor the consequence, and a reader could not tell
 * whether the plugin was broken or whether anything was expected of them.
 *
 * The locale tables are plain object literals, so they are read as text and
 * parsed rather than imported: importing a `.ts` file would need a transpiler,
 * and this script is meant to run on a bare Node with no build step.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** The package root: this script lives in `scripts/`, one level down. */
const root = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url))
const source = readFileSync(`${root}/src/client/locales.ts`, 'utf8')

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail === undefined ? '' : ` (${detail})`}`)
  else process.stdout.write(`ok   ${label}\n`)
}

/**
 * Extract one `key: 'value'` pair from the locale source, for a given table.
 *
 * The tables are `export const zh: WorkBuddySettingsKey = { ... }` and the
 * English equivalent; splitting on the declaration keeps a key that appears in
 * both from being read out of the wrong one.
 */
function table(language) {
  const marker = language === 'zh' ? 'export const zh' : 'export const en'
  const start = source.indexOf(marker)
  if (start < 0) throw new Error(`locale table ${language} not found`)
  const open = source.indexOf('{', start)
  const end = source.indexOf('\n}', open)
  return source.slice(open, end)
}

/** Read one string entry, honouring single-quoted values with escapes. */
function read(body, key) {
  const pattern = new RegExp(`^\\s*${key}:\\s*'((?:[^'\\\\]|\\\\.)*)'`, 'mu')
  const match = pattern.exec(body)
  if (match === null) throw new Error(`key ${key} not found`)
  return match[1].replace(/\\'/gu, "'").replace(/\\\\/gu, '\\')
}

const zh = table('zh')
const en = table('en')

const OLD_ZH = '该模型不校验该参数'
const OLD_EN = 'This model does not check the effort parameter'

for (const [label, body, old, expectations] of [
  ['zh', zh, OLD_ZH, {
    badge: 'probeResultNotValidating',
    tooltip: 'probeTooltipNotValidating',
    note: 'probeNoteNotValidating',
    mechanism: /不存在|不检查|不会改变/u,
    consequence: /默认档位/u,
    reassurance: /无需处理|不是检测失败/u,
  }],
  ['en', en, OLD_EN, {
    badge: 'probeResultNotValidating',
    tooltip: 'probeTooltipNotValidating',
    note: 'probeNoteNotValidating',
    mechanism: /ignores|impossible|would not change/u,
    consequence: /default level/u,
    reassurance: /no action|not a failed/u,
  }],
]) {
  process.stdout.write(`--- ${label} ---\n`)
  const badge = read(body, expectations.badge)
  const tooltip = read(body, expectations.tooltip)
  const note = read(body, expectations.note)

  for (const [key, text] of [[expectations.badge, badge], [expectations.tooltip, tooltip], [expectations.note, note]]) {
    check(`${label} ${key} replaced`, text !== old, text)
    check(`${label} ${key} has no placeholder`, !text.includes('{'), text)
    process.stdout.write(`     ${key}: ${text}\n`)
  }
  // The badge is a narrow chip in a single row.
  check(`${label} badge fits a chip`, badge.length <= (label === 'zh' ? 16 : 32), `${badge.length} chars`)
  // The tooltip is a bounded one-liner above a composer control.
  check(`${label} tooltip stays brief`, tooltip.length <= (label === 'zh' ? 45 : 120), `${tooltip.length} chars`)
  // The note carries the full explanation.
  check(`${label} note explains the mechanism`, expectations.mechanism.test(note))
  check(`${label} note states the consequence`, expectations.consequence.test(note))
  check(`${label} note reassures rather than alarms`, expectations.reassurance.test(note))
  check(`${label} note is longer than the badge`, note.length > badge.length)
}

// Both tables must declare the same keys, or one language silently misses one.
const keysOf = body => [...body.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*):/gmu)].map(m => m[1]).sort().join(',')
check('zh and en declare the same keys', keysOf(zh) === keysOf(en))

process.stdout.write(failures.length === 0
  ? '\nAll copy checks passed.\n'
  : `\n${failures.length} copy check(s) failed:\n${failures.map(f => `  - ${f}`).join('\n')}\n`)
process.exit(failures.length === 0 ? 0 : 1)
