/**
 * WorkBuddy 5.6+ at-rest credential envelopes (`$wbEncrypted`): classification,
 * key resolution, and field decryption for the desktop app's encrypted auth
 * files.
 *
 * Since WorkBuddy 5.6 the desktop app encrypts `auth.accessToken`,
 * `auth.refreshToken` and `account.nickname` at rest
 * (`buildPolicy: "fields"`, on by default), so the plugin reads
 * `{$wbEncrypted:1, envelope}` wrappers instead of token strings. Everything
 * needed to open them lives on the same machine:
 *
 * - the sealed payload (`{version:1, atRestSecretKey}`) comes from the
 *   WorkBuddy-modified Electron's private `workbuddyStorage` binding, reached
 *   by running *its own* binary once with `ELECTRON_RUN_AS_NODE=1`;
 * - `protectorKey = sha256(atRestSecretKey, utf8)` opens the envelopes with
 *   AES-256-GCM; the AAD builder in `decrypt.ts` is transcribed from the app's
 *   own `buildAuthenticatedContextAad`.
 *
 * The plugin process itself can never call `_linkedBinding` (it runs in DSH's
 * Node, not the forked Electron), so the helper is spawned. The key is cached
 * in memory only, single-flight, and re-resolved when an envelope names a
 * different key id. Neither the payload, the key, nor any token is ever
 * logged; error messages carry sizes, ids, and exit codes only.
 *
 * Two callers share this module and deliberately differ in how they use the
 * resolved key:
 *
 * - the **model provider** (single current credential) must open the current
 *   document or fail loudly, so it enforces the envelope's key id;
 * - the **check-in** (every historical account) matches each envelope
 *   individually, because a backup sealed by a previous install must be
 *   skipped rather than failing the whole scan.
 *
 * Both shapes are therefore exported: {@link WorkBuddyAtRestKeyProvider} for
 * the provider's strict resolution, and the plain {@link protectorKey}
 * resolver the scanner uses.
 *
 * The implementation moved to `src/credential/` so the credential store and
 * the key provider share one module; this file stays as the historical import
 * site for `bin.ts`, `checkin.ts` and `index.ts`.
 *
 * @module dsh-buddy-suite/desktop-credential-protection
 */

export * from './credential/index.ts'
