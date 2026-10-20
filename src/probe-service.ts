/**
 * Probe orchestration: the serial queue, the consent gate, and the bridge from
 * an observation to what the adapter may expose.
 *
 * Kept separate from {@link module:dsh-buddy-suite/probe} so the protocol
 * stays a pure function of one model's responses, while queueing, persistence,
 * and policy live here. Two rules from `docs/reasoning-effort-probe-plan.md`
 * §3.3 are structural rather than advisory:
 *
 * - one probe at a time (a user's real chat must not contend with a sweep),
 * - nothing at all happens without explicit consent.
 *
 * @module dsh-buddy-suite/probe-service
 */

import type { WorkBuddyCredentialStore } from './auth.ts'
import type { WorkBuddyCatalog } from './catalog.ts'
import { probeModel, type ProbeRegion, type ProbeSender, type SentinelFactory } from './probe.ts'
import { fingerprintModel, type WorkBuddyProbeRecord, type WorkBuddyProbeStore } from './probe-store.ts'
import type { WorkBuddyUpstreamClient } from './upstream.ts'

/** What the caller learns about a completed probe. */
export type WorkBuddyProbeStatus =
  | { state: 'ok'; validation: WorkBuddyProbeRecord['validation']; efforts: readonly string[]; requests: number }
  | { state: 'unavailable'; reason: string }

/** Options for {@link WorkBuddyProbeService}. */
export interface WorkBuddyProbeServiceOptions {
  store: WorkBuddyProbeStore
  catalog: WorkBuddyCatalog
  credentials: WorkBuddyCredentialStore
  client: WorkBuddyUpstreamClient
  /** Whether probing is permitted at all; consulted before every sweep. */
  consent: () => boolean
  /**
   * The account currently in effect, as `uid:enterpriseId`, or `undefined`
   * while signed out.
   *
   * Records are read and written against this identity, and it is re-checked
   * after the sweep finishes: an observation produced under account A must not
   * be stored once account B is in effect, however long the probe took. The
   * store's per-account keying alone cannot catch that, because an in-flight
   * probe completes *after* the switch has already happened.
   */
  account: () => string | undefined
  sentinel?: SentinelFactory
  /**
   * Which endpoint's rejection vocabulary sweeps read. The two apps talk to
   * different upstreams that answer a bad effort with different codes, so each
   * runtime passes its own region instead of sharing one widening set.
   */
  region: ProbeRegion
  /** Injectable for tests; defaults to the live upstream sender. */
  send?: (modelId: string) => ProbeSender
}

/**
 * Serial probe runner. One instance is shared by the manual API and any
 * future automatic trigger, so the two can never overlap.
 */
export class WorkBuddyProbeService {
  private readonly options: WorkBuddyProbeServiceOptions
  private queue: Promise<unknown> = Promise.resolve()
  private readonly pending = new Map<string, Promise<WorkBuddyProbeStatus>>()
  /**
   * How many probes are in flight, counted rather than flagged.
   *
   * A batch holds one across the whole sweep while each model adds its own, so
   * a boolean would be cleared by the first model that finished and the UI
   * would stop reporting progress while the sweep was still running.
   */
  private active = 0
  /** Position of a running batch, for the panel's progress line. */
  private sweep: { done: number; total: number } | undefined

  constructor(options: WorkBuddyProbeServiceOptions) {
    this.options = options
  }

  /** Whether a probe or a batch is in flight right now. */
  isRunning(): boolean {
    return this.active > 0
  }

  /**
   * The record the adapter may use for this model, or `undefined`.
   *
   * Applies the plan's precedence (§5): a declared set always wins, so a model
   * that declares `supportedEfforts` is never answered from an observation.
   */
  recordFor(modelId: string): WorkBuddyProbeRecord | undefined {
    const info = this.options.catalog.current().find(model => model.id === modelId)
    if (info === undefined) return undefined
    if (info.reasoning?.supportedEfforts !== undefined && info.reasoning.supportedEfforts.length > 0) {
      return undefined
    }
    const account = this.options.account()
    // Signed out: there is no account to attribute an observation to, so none
    // is served (a previous account's record must not answer here).
    if (account === undefined) return undefined
    return this.options.store.get(modelId, fingerprintModel(info), account)
  }

  /**
   * Probe one model, serially.
   *
   * The authenticated manual route supplies one-request consent after UI
   * confirmation. Other callers must pass the configured consent gate.
   * Manual consent never changes the automatic-probing configuration.
   * Explicit requests bypass historical results, but share an ongoing run.
   */
  async probe(modelId: string, manualConsent = false): Promise<WorkBuddyProbeStatus> {
    if (!manualConsent && !this.options.consent()) {
      return { state: 'unavailable', reason: 'probing is not authorized' }
    }
    const info = this.options.catalog.current().find(model => model.id === modelId)
    if (info === undefined) return { state: 'unavailable', reason: `unknown model: ${modelId}` }
    const account = this.options.account()
    if (account === undefined) return { state: 'unavailable', reason: 'no WorkBuddy credential' }
    const pendingKey = JSON.stringify([account, modelId])
    const pending = this.pending.get(pendingKey)
    if (pending !== undefined) return pending

    const run = this.queue.then(async (): Promise<WorkBuddyProbeStatus> => {
      // Re-read inside the queue: an earlier sweep may have changed the catalog
      // or already answered this model.
      const current = this.options.catalog.current().find(model => model.id === modelId)
      if (current === undefined) return { state: 'unavailable', reason: `unknown model: ${modelId}` }
      if (!manualConsent && !this.options.consent()) {
        return { state: 'unavailable', reason: 'probing is not authorized' }
      }
      if (current.reasoning?.supports !== true || (current.reasoning.supportedEfforts?.length ?? 0) > 0) {
        return { state: 'unavailable', reason: 'model does not need detection' }
      }
      const cached = this.recordFor(modelId)
      if (!manualConsent && cached !== undefined && cached.validation !== 'unknown') {
        return { state: 'ok', validation: cached.validation, efforts: cached.efforts, requests: 0 }
      }

      // The account this sweep is being run for. Captured before the requests
      // and re-checked before the write-back: a probe can outlive the account
      // it started under (a switch, or a manual refresh, clears records while
      // the sweep is still talking to the upstream), and storing the result
      // afterwards would resurrect the previous account's answer.
      const activeAccount = this.options.account()
      if (activeAccount !== account) return { state: 'unavailable', reason: 'account changed before detection' }
      const credential = await this.options.credentials.current()
      if (credential === undefined) return { state: 'unavailable', reason: 'no WorkBuddy credential' }

      const send = this.options.send === undefined
        ? (effort: string | undefined, signal: AbortSignal, maxTokens?: number) =>
            this.options.client.probeEffort(credential, modelId, effort, signal, maxTokens)
        : this.options.send(modelId)

      this.active += 1
      try {
        const outcome = await probeModel({
          send,
          region: this.options.region,
          // Some models refuse a request that omits `reasoning_effort`
          // altogether (measured on `glm-5.1`: 400 / `1210` "the reasoning
          // effort value is not supported by the current model"). The catalog's
          // declared default is a value the upstream itself says the model
          // uses, so the baseline sends it instead of omitting the field. When
          // the row declares nothing there is nothing to send and the baseline
          // omits as before.
          ...current.reasoning?.defaultEffort === undefined
            ? {}
            : { baselineEffort: current.reasoning.defaultEffort },
          ...this.options.sentinel === undefined ? {} : { sentinel: this.options.sentinel },
        })
        // The account may have changed while the requests were in flight. Drop
        // the observation rather than attribute it to whoever is signed in now.
        if (this.options.account() !== account) {
          return { state: 'unavailable', reason: 'account changed during detection' }
        }
        const record = this.options.store.record(
          fingerprintModel(current),
          outcome.validation,
          outcome.efforts,
          account,
          // Keep the explanation with the observation: an `unknown` record that
          // does not say why is indistinguishable from a broken request path,
          // and the only other way to learn the cause is to spend another
          // round of credit. Only an inconclusive outcome carries a reason.
          outcome.validation === 'unknown' ? outcome.reason : undefined,
        )
        this.options.store.set(modelId, record)
        if (outcome.validation === 'unknown') {
          return { state: 'unavailable', reason: outcome.reason }
        }
        return { state: 'ok', validation: outcome.validation, efforts: record.efforts, requests: outcome.requests }
      } finally {
        this.active = Math.max(0, this.active - 1)
      }
    })

    // Keep the chain alive regardless of this run's outcome, so one failure does
    // not poison every later probe.
    this.queue = run.catch(() => undefined)
    this.pending.set(pendingKey, run)
    try {
      return await run
    } finally {
      this.pending.delete(pendingKey)
    }
  }

  /**
   * Probe several models, one after another, and report how far it got.
   *
   * Serial on purpose: the queue already guarantees one probe at a time so a
   * user's real chat never contends with a sweep, and a batch is just that
   * guarantee applied to a list. Requests are never fired concurrently — the
   * upstream is asked one model at a time, in the order given.
   *
   * The sweep is not atomic: whatever completes is stored, and a model that
   * fails does not stop the rest. Callers get one status per model, in order.
   *
   * An account switch ends the sweep early. Every remaining model would be
   * probed under an identity the user did not consent to, and the per-model
   * guard would discard the results anyway.
   */
  async probeMany(modelIds: readonly string[], manualConsent = false): Promise<{ modelId: string; status: WorkBuddyProbeStatus }[]> {
    const startingAccount = this.options.account()
    const results: { modelId: string; status: WorkBuddyProbeStatus }[] = []
    this.active += 1
    this.sweep = { done: 0, total: modelIds.length }
    try {
      for (const modelId of modelIds) {
        if (this.options.account() !== startingAccount) break
        results.push({ modelId, status: await this.probe(modelId, manualConsent) })
        this.sweep.done = results.length
      }
    } finally {
      this.sweep = undefined
      this.active = Math.max(0, this.active - 1)
    }
    return results
  }

  /** How far a running batch has got, or `undefined` outside one. */
  progress(): { done: number; total: number } | undefined {
    return this.sweep === undefined ? undefined : { ...this.sweep }
  }

  /**
   * The candidates a batch should visit: probeable models with no decisive
   * observation yet.
   *
   * A model already answered `validating` or `non-validating` is settled, so
   * including it would spend credit to re-learn what the store already holds.
   * The rows this batch exists for are exactly the ones still showing "detection
   * did not complete", which is the state a user cannot fix one click at a time
   * without going row by row.
   */
  unresolvedCandidates(): string[] {
    const account = this.options.account()
    if (account === undefined) return []
    return this.options.catalog.current()
      .filter(info => info.reasoning?.supports === true && (info.reasoning.supportedEfforts?.length ?? 0) === 0)
      .filter(info => {
        const record = this.options.store.get(info.id, fingerprintModel(info), account)
        return record === undefined || record.validation === 'unknown'
      })
      .map(info => info.id)
  }
}
