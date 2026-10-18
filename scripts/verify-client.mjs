/**
 * Exercise the built browser bundle against a stand-in Cordis context.
 *
 * The smoke test proves the bundle parses and exports the right surface; this
 * one proves `apply()` actually registers every contribution it claims to.
 * The context here records slot registrations instead of rendering them, which
 * is enough to catch a slot name that drifted from what the host declares.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The package root: this script lives in `scripts/`, one level down. */
const root = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url))
// React is resolved from the package root, where the bundle resolves it too.
const require = createRequire(pathToFileURL(`${root}/package.json`).href)
const source = readFileSync(`${root}/lib/client.js`, 'utf8')

const registered = []
const effects = []
let captured

globalThis.window = {}
globalThis.window.__ModuleLoader__ = {
  load({ id, factory }) {
    captured = {
      id,
      exports: factory(name => {
        if (name === 'react' || name === 'react/jsx-runtime') return require(name)
        throw new Error(`the client bundle required an unexpected host module: ${name}`)
      }),
    }
  },
}

// The bundle's own registration line, evaluated with `window` in place.
new Function('window', 'require', source)(globalThis.window, require)

/** A stand-in slots service that records what gets registered. */
const slots = {
  inject(name, callback) {
    registered.push({ kind: 'inject', slot: name })
    // The host calls the callback when the slot's declaration commits; calling
    // it immediately exercises the same registration path.
    callback()
  },
  register(definition) {
    registered.push({ kind: 'register', slot: definition.name, id: definition.id ?? definition.key })
    return () => {}
  },
}

const locale = {
  register() { return () => {} },
  bind() { return key => key },
}

/** The stand-in client context. */
const ctx = {
  slots,
  locale,
  effect(fn) { effects.push(fn); return () => {} },
  get() { return undefined },
  inject(name, callback) {
    registered.push({ kind: 'ctx.inject', services: [name].flat().join(',') })
    // `modelDirectories` is the only injected service the bundle uses.
    callback({
      slots,
      modelDirectories: {
        directoryFor: () => ({ store: {} }),
      },
    })
  },
  logger: {
    info() {},
    warn() {},
    error() {},
  },
}

const failures = []
const check = (label, condition, detail) => {
  if (!condition) failures.push(`${label}${detail === undefined ? '' : ` (${detail})`}`)
  else process.stdout.write(`ok   ${label}\n`)
}

const { apply, name } = captured.exports
check('bundle id', captured.id === 'dsh-buddy-suite', captured.id)
check('client plugin name', name === 'dsh-buddy-suite-client', name)

apply(ctx)

/**
 * Every slot the bundle claims to fill, with the id/key it uses.
 *
 * All four list-slot entry ids are namespaced: dsh-workbuddy-connect fills the
 * same slots, and an id shared between the two would collide.
 */
const expected = [
  ['shell.overlay', 'workbuddy-suite-update'],
  ['settings.plugin.item', 'workbuddy-suite'],
  ['settings.plugin.item', 'workbuddy-ai-suite'],
  ['plugins.bundle.config', 'dsh-buddy-suite'],
  ['conversation.input.right', 'workbuddy-suite-probe'],
  ['conversation.session.header.actions', 'buddy-checkin-header'],
]

const actual = registered.filter(entry => entry.kind === 'register')
for (const [slot, id] of expected) {
  check(
    `registers ${slot} "${id}"`,
    actual.some(entry => entry.slot === slot && entry.id === id),
    actual.filter(entry => entry.slot === slot).map(entry => entry.id).join(', ') || 'nothing',
  )
}

check('declares the update-checker lifecycle', effects.length > 0)
check('waits for modelDirectories before the composer seat', registered.some(entry => entry.kind === 'ctx.inject' && entry.services === 'modelDirectories'))

// A broken host seam must not take the other contributions down with it: the
// guard catches per contribution, so a throwing register leaves the rest.
let afterFailure = 0
const brokenSlots = {
  inject(name, callback) {
    if (name === 'settings.plugin.item') throw new Error('host slot shape changed')
    callback()
  },
  register(definition) {
    afterFailure += 1
    return () => {}
  },
}
const brokenCtx = {
  slots: brokenSlots,
  locale,
  effect() { return () => {} },
  get() { return undefined },
  // The scoped inject must hand its callback the *broken* slots: the composer
  // seat registers through this scope, so reusing the healthy ones would hide
  // whether that contribution survived.
  inject(_name, callback) {
    callback({
      slots: brokenSlots,
      modelDirectories: { directoryFor: () => ({ store: {} }) },
    })
  },
  logger: ctx.logger,
}
const errors = []
const originalError = console.error
console.error = (...args) => { errors.push(args.join(' ')) }
try {
  captured.exports.apply(brokenCtx)
} finally {
  console.error = originalError
}
check('degrades one broken seam instead of throwing', errors.length > 0)
// Six contributions exist; breaking `settings.plugin.item` costs its two cards
// and leaves the other four — the update overlay, the Plugins page, the
// composer seat, and the check-in entry.
check('keeps the other contributions', afterFailure === 4, `${afterFailure} registrations survived`)

process.stdout.write(failures.length === 0
  ? '\nAll client registration checks passed.\n'
  : `\n${failures.length} client check(s) failed:\n${failures.map(f => `  - ${f}`).join('\n')}\n`)
process.exit(failures.length === 0 ? 0 : 1)
