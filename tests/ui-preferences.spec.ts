import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_UI_PREFERENCES,
  readUiPreferences,
  WORKBUDDY_UI_PREFS_FILENAME,
  writeUiPreferences,
} from '../src/ui-preferences.ts'

/**
 * Specs for the composer display switches.
 *
 * The request behind them: the credit badge and the reasoning-level entry are
 * useful to an ordinary user, but a user who runs a separate balance plugin, or
 * who switches between providers, sees them twice. So each is switchable — and
 * both default to on, because hiding the feature from the audience it was built
 * for is the worse mistake.
 */

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

/** A temp directory with a preference-file path inside it. */
async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'buddy-ui-prefs-'))
  CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
  return join(dir, WORKBUDDY_UI_PREFS_FILENAME)
}

describe('defaults', () => {
  it('shows both annotations when no file exists', () => {
    // The ordinary user never opens the card; they must get the feature, not an
    // empty composer.
    expect(DEFAULT_UI_PREFERENCES).toEqual({ showCreditBadge: true, showReasoningLevels: true })
  })

  it('reads defaults from a missing file', async () => {
    expect(readUiPreferences(await tempPath())).toEqual(DEFAULT_UI_PREFERENCES)
  })
})

describe('round trip', () => {
  it('persists a switch and reads it back', async () => {
    const path = await tempPath()
    writeUiPreferences({ showCreditBadge: false }, path)
    expect(readUiPreferences(path)).toEqual({ showCreditBadge: false, showReasoningLevels: true })
  })

  it('changes one switch without disturbing the other', async () => {
    // A route that toggles one box never restates the other, so a partial patch
    // must merge rather than reset.
    const path = await tempPath()
    writeUiPreferences({ showCreditBadge: false }, path)
    writeUiPreferences({ showReasoningLevels: false }, path)
    expect(readUiPreferences(path)).toEqual({ showCreditBadge: false, showReasoningLevels: false })
    // And turning one back on leaves the other alone.
    writeUiPreferences({ showCreditBadge: true }, path)
    expect(readUiPreferences(path)).toEqual({ showCreditBadge: true, showReasoningLevels: false })
  })

  it('writes a versioned document', async () => {
    const path = await tempPath()
    writeUiPreferences({ showCreditBadge: false }, path)
    const document = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    expect(document['version']).toBe(1)
    expect(document['preferences']).toEqual({ showCreditBadge: false, showReasoningLevels: true })
  })
})

describe('malformed files read as defaults', () => {
  it('ignores unparsable JSON', async () => {
    const path = await tempPath()
    await writeFile(path, '{ not json')
    // A preference file is not worth failing a plugin over, and "show
    // everything" is the safe direction to fail in.
    expect(readUiPreferences(path)).toEqual(DEFAULT_UI_PREFERENCES)
  })

  it('ignores an unknown format version', async () => {
    const path = await tempPath()
    await writeFile(path, JSON.stringify({ version: 99, preferences: { showCreditBadge: false } }))
    expect(readUiPreferences(path)).toEqual(DEFAULT_UI_PREFERENCES)
  })

  it('does not coerce a string into a boolean', async () => {
    // A hand-edited `"false"` must not silently turn the badge off: only a real
    // boolean is honoured, and anything else keeps the default.
    const path = await tempPath()
    await writeFile(path, JSON.stringify({
      version: 1,
      preferences: { showCreditBadge: 'false', showReasoningLevels: 0 },
    }))
    expect(readUiPreferences(path)).toEqual(DEFAULT_UI_PREFERENCES)
  })

  it('fills a missing field with its default', async () => {
    const path = await tempPath()
    await writeFile(path, JSON.stringify({ version: 1, preferences: { showCreditBadge: false } }))
    expect(readUiPreferences(path)).toEqual({ showCreditBadge: false, showReasoningLevels: true })
  })
})
