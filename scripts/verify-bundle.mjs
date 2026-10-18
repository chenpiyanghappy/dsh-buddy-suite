/**
 * Smoke-test the built bundle without a DSH host.
 *
 * Loads `lib/index.js` and asserts the parts a host would rely on: the plugin
 * name, the injected services, the provider ids, the check-in route constants,
 * and that the browser half's bundle is a well-formed CommonJS module-loader
 * registration. Nothing here touches the network or the real credential files.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The package root: this script lives in `scripts/`, one level down. */
const root = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url))
const failures = []
const check = (label, condition, detail) => {
  if (!condition) failures.push(`${label}${detail === undefined ? '' : ` (${detail})`}`)
  else process.stdout.write(`ok   ${label}\n`)
}

// ---- host half ----
const host = await import(pathToFileURL(`${root}/lib/index.js`).href)

check('plugin name', host.name === 'llm-workbuddy', `got ${host.name}`)
check('injects the llm service', Array.isArray(host.inject) && host.inject.includes('llm'))
check('exposes Config', host.Config !== undefined)
check('exposes apply', typeof host.apply === 'function')

// Both product variants must be there, and their routes namespaced to this
// bundle (a route left on the old package name would never be mounted).
const variants = host.WORKBUDDY_VARIANTS ?? []
check('two variants', variants.length === 2, `got ${variants.length}`)
check('CN provider id', variants.some(v => v.id === 'workbuddy'))
check('AI provider id', variants.some(v => v.id === 'workbuddy-ai'))
for (const variant of variants) {
  check(`${variant.id} status route namespaced`, variant.statusPath.startsWith('/plugins/dsh-buddy-suite/'), variant.statusPath)
  check(`${variant.id} probe route namespaced`, variant.probePath.startsWith('/plugins/dsh-buddy-suite/'), variant.probePath)
}

// ---- check-in half ----
check('check-in route', host.BUDDY_CHECKIN_PATH === '/plugins/dsh-buddy-suite/checkin', host.BUDDY_CHECKIN_PATH)
check('balance route', host.BUDDY_CHECKIN_BALANCE_PATH === '/plugins/dsh-buddy-suite/checkin/balance', host.BUDDY_CHECKIN_BALANCE_PATH)
check('state filename', host.BUDDY_CHECKIN_FILENAME === '.buddy-checkin.json', host.BUDDY_CHECKIN_FILENAME)
for (const fn of ['discover', 'check', 'run', 'ensureToday', 'refreshBalances', 'retryFailed', 'claimNotice', 'documentOf', 'status', 'today', 'authDirsFor']) {
  check(`exports ${fn}()`, typeof host[fn] === 'function')
}

// The check-in and the provider must not have drifted into two versions.
check('one version constant', host.BUDDY_SUITE_VERSION === host.WORKBUDDY_CONNECT_VERSION, `${host.BUDDY_SUITE_VERSION} vs ${host.WORKBUDDY_CONNECT_VERSION}`)

// A pure function through the real build: the day must be the app's own zone,
// not the machine's.
const day = host.today()
check('today() is YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/u.test(day), day)

// ---- browser half ----
const clientSource = readFileSync(`${root}/lib/client.js`, 'utf8')
// The banner is emitted with line breaks, so match its content rather than one
// literal line: the loader registration must name this bundle's package.
check(
  'client is a module-loader registration',
  /window\.__ModuleLoader__\.load\(\{\s*id:\s*"dsh-buddy-suite"/u.test(clientSource),
)
check('client closes the registration', /return module\.exports;[\s\S]*\}\);\s*$/u.test(clientSource))
check('client requires only React from the host', !/require\("(?!react|react\/jsx-runtime)/u.test(clientSource))
// Each contribition must have made it into the bundle.
for (const slot of [
  'conversation.session.header.actions',
  'conversation.input.right',
  'plugins.bundle.config',
  'settings.plugin.item',
  'shell.overlay',
]) {
  check(`client registers ${slot}`, clientSource.includes(slot))
}
check('client mounts the check-in panel', clientSource.includes('buddy-checkin-header'))

process.stdout.write(failures.length === 0
  ? '\nAll smoke checks passed.\n'
  : `\n${failures.length} smoke check(s) failed:\n${failures.map(f => `  - ${f}`).join('\n')}\n`)
process.exit(failures.length === 0 ? 0 : 1)
