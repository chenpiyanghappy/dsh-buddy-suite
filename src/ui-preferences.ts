/**
 * Composer-chrome display preferences: which WorkBuddy annotations the
 * conversation input box shows.
 *
 * Two controls compete for the composer's right-hand seat: the credit badge
 * (this account's remaining credit) and the reasoning-level entry. Both are
 * useful on their own and both are noise to somebody:
 *
 * - a user who runs a dedicated balance plugin sees the same number twice;
 * - a user who switches between providers sees two sets of reasoning controls;
 * - a user who only wants to pick a model wants neither.
 *
 * So each is switchable, and both default to **on**: the feature is useful to
 * the ordinary user who never opens settings, and the user who minds it can
 * turn it off. Defaulting off would hide the feature from the audience it was
 * built for, which is the worse mistake.
 *
 * This is global rather than per-account, unlike the model-visibility store:
 * it describes how *this machine's* composer should look, not what one
 * account's entitlement is. Switching accounts by logging the other app in
 * should not silently bring a badge back.
 *
 * Why a plugin-owned file rather than a settings section: DSH 0.2.x dropped the
 * section API (`installSection`), so a plugin cannot register a settings field
 * on current cores. The same reasoning the visibility store documents applies,
 * and this file follows its shape — a version-tagged document, atomic write
 * with `0o600`, and a malformed file that reads as "nothing saved" rather than
 * throwing.
 *
 * @module dsh-buddy-suite/ui-preferences
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** On-disk format this reader accepts; other versions are discarded. */
const UI_PREFS_FORMAT_VERSION = 1

/** Basename of the preference file inside the Harness home. */
export const WORKBUDDY_UI_PREFS_FILENAME = '.workbuddy-ui-preferences.json'

/**
 * What the composer shows for this plugin.
 *
 * Both fields are optional on the wire so an older file keeps working, and a
 * missing field means "use the default" — which is `true` for both.
 */
export interface WorkBuddyUiPreferences {
  /** Show the account's remaining credit beside the composer. */
  showCreditBadge: boolean
  /** Show the reasoning-level entry beside the composer. */
  showReasoningLevels: boolean
}

/** The defaults: everything visible, matching the pre-switch behaviour. */
export const DEFAULT_UI_PREFERENCES: WorkBuddyUiPreferences = {
  showCreditBadge: true,
  showReasoningLevels: true,
}

/** The persisted document. */
interface SavedDocument {
  version: typeof UI_PREFS_FORMAT_VERSION
  preferences: Partial<WorkBuddyUiPreferences>
}

/** The preference file's path inside the Harness home. */
export function workbuddyUiPrefsPath(): string {
  return join(resolveDshHome(), WORKBUDDY_UI_PREFS_FILENAME)
}

/**
 * Read one boolean, accepting only a real boolean.
 *
 * A string like `"false"` is *not* coerced: a hand-edited file with the wrong
 * type reads as "unset" and keeps the default, rather than silently turning a
 * feature off because of how a value happened to be spelled.
 */
function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * The stored preferences, with defaults filled in.
 *
 * Every failure mode — absent file, unparsable JSON, wrong version, wrong
 * shape — reads as the defaults. A preference file is not worth failing a
 * plugin over, and "show everything" is the safe direction to fail in: the user
 * sees the feature rather than a silently empty composer.
 */
export function readUiPreferences(path: string = workbuddyUiPrefsPath()): WorkBuddyUiPreferences {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { ...DEFAULT_UI_PREFERENCES }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ...DEFAULT_UI_PREFERENCES }
  }
  const document = parsed as Record<string, unknown>
  if (document['version'] !== UI_PREFS_FORMAT_VERSION) {
    return { ...DEFAULT_UI_PREFERENCES }
  }
  const preferences = document['preferences']
  if (typeof preferences !== 'object' || preferences === null || Array.isArray(preferences)) {
    return { ...DEFAULT_UI_PREFERENCES }
  }
  const wrapped = preferences as Record<string, unknown>
  return {
    showCreditBadge: booleanOr(wrapped['showCreditBadge'], DEFAULT_UI_PREFERENCES.showCreditBadge),
    showReasoningLevels: booleanOr(wrapped['showReasoningLevels'], DEFAULT_UI_PREFERENCES.showReasoningLevels),
  }
}

/**
 * Persist a preference change.
 *
 * Only the keys passed in change; the rest keep their stored (or default)
 * value, so a route that toggles one switch never has to restate the other.
 * Written atomically, so a crash mid-write cannot leave a half-document that
 * reads as defaults and silently re-enables a feature the user turned off.
 *
 * @returns the preferences in effect after the write.
 */
export function writeUiPreferences(
  patch: Partial<WorkBuddyUiPreferences>,
  path: string = workbuddyUiPrefsPath(),
): WorkBuddyUiPreferences {
  const next: WorkBuddyUiPreferences = { ...readUiPreferences(path), ...patch }
  const document: SavedDocument = {
    version: UI_PREFS_FORMAT_VERSION,
    preferences: next,
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
  return next
}
