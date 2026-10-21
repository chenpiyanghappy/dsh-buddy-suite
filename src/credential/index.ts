/**
 * Public surface of the WorkBuddy at-rest credential module.
 *
 * `src/desktop-credential-protection.ts` is a thin re-export of this file so
 * the historical import site keeps working; new code should import from here.
 * Three layers live behind this single exit:
 *
 * - `types.ts` — document/envelope shapes, key source and option types, plus
 *   the product profiles re-exported from `variants.ts`;
 * - `decrypt.ts` — wrapper classification, the transcribed AAD builder,
 *   AES-256-GCM field opening, payload validation and key derivation;
 * - `discover.ts` — Electron location (platform default and Windows uninstall
 *   registry), the WSL-safe helper spawn, and the cached key provider.
 *
 * @module dsh-buddy-suite/credential
 */

export * from './types.ts'
export * from './decrypt.ts'
export * from './discover.ts'
