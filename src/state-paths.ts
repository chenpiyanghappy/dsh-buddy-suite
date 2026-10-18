/**
 * Plugin-owned state file names under `$DSH_HOME`.
 *
 * Node-free so both halves (and the CLI) agree on the names without importing
 * anything that touches the filesystem. Every file the plugin writes lives
 * here; the desktop app's own files are read-only and never written.
 *
 * @module dsh-buddy-suite/state-paths
 */

/** Basename of the check-in state file inside the Harness home. */
export const BUDDY_CHECKIN_FILENAME = '.buddy-checkin.json'
