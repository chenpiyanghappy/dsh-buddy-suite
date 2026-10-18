/**
 * Run this bundle's tests through vitest's programmatic API.
 *
 * `vitest run` loads `vitest.config.ts` by bundling it with rolldown, which
 * resolves real paths by spawning a helper process. The DSH sandbox denies
 * pipe-capturing spawns, so that path fails with `spawn EPERM` no matter how
 * vitest itself was launched.
 *
 * Bypassing the config file avoids it: the `define` the config carried is
 * applied here instead, so the sources see the same build-time constant.
 * Everything else — the include pattern, the node environment — is passed
 * through `viteOverrides`, which vitest merges into the resolved config.
 */
import { createVitest } from 'vitest/node'
import { readFileSync } from 'node:fs'

const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version

const vitest = await createVitest('test', {
  config: false,
  root: process.cwd(),
}, {
  define: {
    __DSH_BUDDY_SUITE_VERSION__: JSON.stringify(PACKAGE_VERSION),
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    // The default forks pool forks a worker process, which the sandbox denies
    // outright. The threads pool runs the specs on worker threads inside this
    // process instead, so no spawn is needed at all.
    pool: 'threads',
    singleThread: true,
  },
})

await vitest.start()
const code = typeof vitest.exitCode === 'number' ? vitest.exitCode : 0
await vitest.close()
process.exit(code)
