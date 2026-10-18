/**
 * The bundle's own version, injected at build time.
 *
 * The build replaces the identifier `__DSH_BUDDY_SUITE_VERSION__` with a
 * string literal (see `tsdown.config.ts` and `vitest.config.ts`), so neither
 * built bundle has to read `package.json` from disk at runtime — a plugin
 * running inside a packaged DSH install has no reliable path to it.
 *
 * The identifier is declared as a `const` here rather than reached through
 * `globalThis`: a global lookup is a *runtime* expression, which a build-time
 * `define` cannot replace — it would have left the bundle falling back to the
 * placeholder forever.
 *
 * @module dsh-buddy-suite/version
 */

declare const __DSH_BUDDY_SUITE_VERSION__: string

/**
 * This bundle's version, for status documents and diagnostics.
 *
 * `typeof` guards the un-substituted case: a bundle built without the define
 * (a bare `tsc` output, say) reads the placeholder instead of throwing on an
 * undeclared identifier.
 */
export const BUDDY_SUITE_VERSION = typeof __DSH_BUDDY_SUITE_VERSION__ === 'string'
  ? __DSH_BUDDY_SUITE_VERSION__
  : '0.0.0-dev'

/**
 * The same value under the provider half's long-standing name.
 *
 * The provider modules were carried over from the model-provider plugin and
 * read this constant directly; keeping one alias means there is exactly one
 * version in the bundle, not two that can drift apart.
 */
export const WORKBUDDY_CONNECT_VERSION = BUDDY_SUITE_VERSION
