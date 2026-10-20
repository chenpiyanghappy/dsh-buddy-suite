import { createServer, request, type IncomingMessage, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { workBuddyProbeHandler } from '../src/probe-route.ts'
import type { WorkBuddyProbeRouteOptions } from '../src/probe-route.ts'
import type { ServerResponse } from 'node:http'

/**
 * The batch action's contract on the control route.
 *
 * `probe-all` is the one action that spends credit on more than one model, so
 * the route must (a) reach the host's batch handler, (b) answer a host that has
 * no batch support with a refusal instead of a crash, and (c) keep the same
 * loopback + key guards as every other write. The response is deliberately a
 * short acknowledgement — the work itself is observed through the status
 * document — so the tests pin the shape, not a duration.
 */

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

const KEY = 'test-probe-key'

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): Promise<string> {
  const server: Server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  CLEANUP.push(() => new Promise<void>(resolve => { server.close(() => resolve()) }))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function post(base: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number, body: string }> {
  const url = new URL(base)
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = request({
      host: url.hostname,
      port: url.port,
      method: 'POST',
      path: '/plugins/dsh-buddy-suite/probe',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Origin': base,
        'x-workbuddy-probe-key': KEY,
        ...headers,
      },
    }, res => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

/** Route options with every action stubbed, overrideable per test. */
function deps(overrides: Partial<WorkBuddyProbeRouteOptions> = {}): WorkBuddyProbeRouteOptions {
  return {
    probe: async () => ({ state: 'ok' }),
    clear: () => {},
    ...overrides,
  }
}

describe('probe-all', () => {
  it('reaches the batch handler and answers its acknowledgement', async () => {
    let called = 0
    const base = await serve(workBuddyProbeHandler(deps({
      probeAll: () => {
        called += 1
        return { state: 'started', total: 4 }
      },
    }), KEY))

    const response = await post(base, { action: 'probe-all' })

    expect(called).toBe(1)
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ state: 'started', total: 4 })
  })

  it('accepts an asynchronous batch handler too', async () => {
    const base = await serve(workBuddyProbeHandler(deps({
      probeAll: async () => ({ state: 'started', total: 2 }),
    }), KEY))

    const response = await post(base, { action: 'probe-all' })

    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({ state: 'started' })
  })

  it('refuses when the host cannot run a batch', async () => {
    // A host that predates the action must say so, not silently do nothing.
    const base = await serve(workBuddyProbeHandler(deps(), KEY))

    const response = await post(base, { action: 'probe-all' })

    expect(response.status).toBe(404)
    expect(JSON.parse(response.body)).toEqual({ error: 'probe-all-not-supported' })
  })

  it('requires the control key like every other write', async () => {
    let called = 0
    const base = await serve(workBuddyProbeHandler(deps({
      probeAll: () => { called += 1; return { state: 'started', total: 1 } },
    }), KEY))

    const response = await post(base, { action: 'probe-all' }, { 'x-workbuddy-probe-key': 'wrong' })

    expect(response.status).toBe(403)
    expect(called).toBe(0)
  })

  it('refuses a non-loopback origin', async () => {
    let called = 0
    const base = await serve(workBuddyProbeHandler(deps({
      probeAll: () => { called += 1; return { state: 'started', total: 1 } },
    }), KEY))

    const response = await post(base, { action: 'probe-all' }, { 'Origin': 'https://evil.example' })

    expect(response.status).toBe(403)
    expect(called).toBe(0)
  })

  it('still routes a single-model probe to its own handler', async () => {
    const probed: string[] = []
    const base = await serve(workBuddyProbeHandler(deps({
      probe: async modelId => { probed.push(modelId); return { state: 'ok' } },
      probeAll: () => ({ state: 'started', total: 1 }),
    }), KEY))

    await post(base, { action: 'probe', model: 'glm-5.1' })

    expect(probed).toEqual(['glm-5.1'])
  })
})
