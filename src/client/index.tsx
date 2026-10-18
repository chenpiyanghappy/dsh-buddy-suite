/**
 * Browser half: the WorkBuddy account cards, the composer's reasoning-probe
 * seat, and the daily check-in entry — on whichever surfaces the host
 * provides.
 *
 * One bundle serves several DSH generations. DSH 0.1.5 renders plugin cards in
 * the settings Plugins tab, which dispatches the keyed `settings.plugin.item`
 * slot once per served settings namespace. DSH 0.1.6 moved plugin
 * configuration to the Plugins page, whose `plugins.bundle.config` slot
 * carries one bundle-keyed entry that renders both variants itself.
 * `ctx.slots.inject` follows the slot's declaration lifetime — the callback
 * runs where the slot is declared and simply never runs where it is not — so
 * registering BOTH seams needs no host-version check: each host materializes
 * exactly the seam it ships.
 *
 * The check-in entry follows the same rule: it mounts into the conversation
 * header's action list, and a host without that seat simply never fires its
 * inject.
 *
 * @module dsh-buddy-suite/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the slot declarations this bundle registers into. Cross-plugin
// collaboration goes through cordis services, so value imports would fail the
// client bundle-purity gate; at runtime each host declares only the slots it
// ships.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { WorkBuddyProbeControl } from './WorkBuddyProbeControl.tsx'
import { WorkBuddyUpdateOverlay } from './WorkBuddyUpdateNotice.tsx'
import { WorkBuddyUpdateStore } from './update-store.ts'
import { WORKBUDDY_CONNECT_VERSION } from '../version.ts'
import { WorkBuddyConfigPage } from './WorkBuddyConfigPage.tsx'
import { CARD_VARIANTS, WorkBuddyPluginCard } from './WorkBuddyPluginCard.tsx'
import type { WorkBuddyPluginCardInjected } from './WorkBuddyPluginCard.tsx'
import { BuddyCheckinPanel } from './BuddyCheckinPanel.tsx'
import { en, zh } from './locales.ts'
import type { WorkBuddySettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** WorkBuddy plugin card copy. */
    'settings.workbuddy': WorkBuddySettingsKey
  }
  interface SlotMap {
    /**
     * Compile-time mirror of the shell's overlay seat (declared at runtime by
     * the ui-layout AppFrame, which this bundle does not depend on): a list
     * slot the shell renders over the whole app, click-through until an entry
     * opts into pointer events.
     */
    'shell.overlay': {
      kind: 'list'
      scope: 'root'
      owner: WorkBuddyShellOverlayOwnerProps
    }
    /**
     * Compile-time mirror of DSH 0.1.5's settings Plugins-tab seat.
     *
     * DSH 0.2.0 dropped this slot entirely, so no shipped dependency declares
     * the key any more and the name is not in `SlotMap`. The mirror keeps the
     * 0.1.5 seam compiling: that slot's declaration lifetime still decides
     * whether the registration runs.
     */
    'settings.plugin.item': {
      kind: 'keyed'
      scope: 'root'
      owner: WorkBuddyLegacySettingsCardOwnerProps
    }
  }
}

/** Owner share of the 0.1.5 settings-tab seat: the tab supplies nothing to entries. */
interface WorkBuddyLegacySettingsCardOwnerProps {
  children?: never
}

/** Owner share of the overlay seat: the frame supplies nothing to entries. */
interface WorkBuddyShellOverlayOwnerProps {
  children?: never
}

/** Stable browser-plugin name. */
export const name = 'dsh-buddy-suite-client'

/**
 * The bundle's package name, which is also this half's configuration key.
 *
 * The Plugins page dispatches `plugins.bundle.config` by the bundle's package
 * name, so the key has to spell exactly what the profile installs.
 */
export const BUNDLE_NAME = 'dsh-buddy-suite'

/**
 * Client services required by this browser half.
 *
 * `modelDirectories` reads the active session through `remote.session`.
 * Declaring that dependency at the client entry is required by the Desktop
 * renderer; without it Cordis rejects `directoryFor()` before this bundle can
 * finish registering its contributions.
 */
export const inject = ['slots', 'locale', 'remote', 'remote.session']

/** Prefix every guarded client contribution's degradation logs with this. */
const CLIENT_CONTRIBUTION_FAILED = '[dsh-buddy-suite] client contribution failed to load (host provider unaffected):'

/** Disposer handed back when a deferred registration degraded: nothing to undo. */
const NOOP_DISPOSER = (): void => {}

/**
 * Run ONE browser-side contribution, degrading its failure to a `console.error`
 * instead of throwing into the DSH loader. Returns the contribution's own
 * value on success, or `undefined` when it degraded — the deferred slot
 * callbacks below substitute `NOOP_DISPOSER` for that, because the slot
 * runtime always expects a disposer back.
 *
 * Every contribution is guarded at BOTH boundaries where it can throw:
 *
 * 1. the eager `ctx.slots.inject(...)` / `ctx.inject(...)` call itself, which
 *    runs synchronously inside `apply()` — e.g. a slot-API shape break;
 * 2. the deferred callback, which the slot runtime invokes later — when the
 *    owner commits the slot's declaration, or when the injected services
 *    arrive — long after `apply()` has returned.
 *
 * The pair is what makes the contributions independent: a failure in one
 * settings seam, or in the check-in entry, leaves every other registration
 * intact. Guards are for THIS browser half only; the host half reports its own
 * errors through `ctx.logger`.
 */
function guardClientContribution<T>(label: string, fn: () => T): T | undefined {
  try {
    return fn()
  } catch (error: unknown) {
    console.error(`${CLIENT_CONTRIBUTION_FAILED} ${label}`, error)
    return undefined
  }
}

/**
 * Register the card copy and every contribution, one guarded contribution at a
 * time.
 *
 * A DSH slot-API breaking change degrades to a `console.error` per
 * contribution instead of throwing into the DSH loader and raising the red
 * "Failed to load plugins" banner; because each contribution carries its own
 * guard, one failing registration never takes the others with it. The host
 * provider keeps working throughout: the `workbuddy` model channel is
 * unaffected, and the check-in host routes keep answering.
 *
 * The tests import this function directly, so its isolation semantics are
 * pinned against the real entry — keep any change to the guarded structure in
 * sync with that spec.
 */
export function apply(ctx: ClientContext): void {
  // The locale copy feeds every contribution below through `t`. Its guard
  // exists only so a broken locale service cannot reach the loader; if it
  // degrades, `t` still binds and renders the key names as fallback copy.
  const namespace = 'settings.workbuddy'
  guardClientContribution('settings copy', () => {
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-buddy-suite: settings copy')
  })
  const t = ctx.locale.bind(namespace) as WorkBuddyPluginCardInjected['t']
  // The update reminder: one store for the whole bundle (the check compares
  // this npm package's own version, so both provider cards share it). It
  // refreshes once on mount through a 7-day localStorage cache and never
  // blocks a contribution — a failed check simply renders nothing.
  const updater = new WorkBuddyUpdateStore(WORKBUDDY_CONNECT_VERSION)
  guardClientContribution('update reminder lifecycle', () => {
    ctx.effect(() => {
      void updater.refresh()
      return () => { updater.dispose() }
    }, 'dsh-buddy-suite: update checker')
  })
  // The floating seat. Hosts whose shell declares no `shell.overlay` seat
  // never fire this callback — the reminder is simply absent there.
  guardClientContribution('update reminder overlay', () => {
    ctx.slots.inject('shell.overlay', () => (
      guardClientContribution('update reminder overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'workbuddy-update',
        order: 40,
        locale: namespace,
        inject: () => ({ t, updater }),
      }, WorkBuddyUpdateOverlay)) ?? NOOP_DISPOSER
    ))
  })
  // SEAM ONE — DSH 0.1.5's settings Plugins tab. One card per variant: they
  // show different accounts, balances, and model sets, so a single merged card
  // could not say which account a number belongs to.
  for (const [index, variant] of CARD_VARIANTS.entries()) {
    const label = `settings.plugin.item card "${variant.id}"`
    guardClientContribution(label, () => {
      ctx.slots.inject('settings.plugin.item', () => (
        guardClientContribution(label, () => ctx.slots.register({
          name: 'settings.plugin.item',
          key: variant.id,
          priority: 30 - index,
          inject: (): WorkBuddyPluginCardInjected => ({ t, variant }),
        }, WorkBuddyPluginCard)) ?? NOOP_DISPOSER
      ))
    })
  }
  // SEAM TWO — DSH 0.1.6+'s Plugins page. One configuration entry for the
  // whole bundle, keyed by its package name as the page dispatches it; the
  // entry mounts both variants' cards itself.
  guardClientContribution('plugins.bundle.config page', () => {
    ctx.slots.inject('plugins.bundle.config', () => (
      guardClientContribution('plugins.bundle.config page', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: BUNDLE_NAME,
        locale: namespace,
      }, WorkBuddyConfigPage)) ?? NOOP_DISPOSER
    ))
  })
  // The reasoning-probe seat in the conversation composer. `modelDirectories`
  // may arrive after this fiber starts, so the scoped callback — and the slot
  // callback inside it — are guarded at their own boundaries too.
  guardClientContribution('conversation probe control', () => {
    ctx.inject(['modelDirectories'], scope => {
      guardClientContribution('conversation probe control', () => {
        scope.slots.inject('conversation.input.right', () => (
          guardClientContribution('conversation probe control', () => scope.slots.register({
            name: 'conversation.input.right',
            id: 'workbuddy-probe',
            order: 10,
            inject: sessionId => ({
              directory: scope.modelDirectories.directoryFor(
                sessionId as Parameters<typeof scope.modelDirectories.directoryFor>[0],
              ).store,
              t,
            }),
          }, WorkBuddyProbeControl)) ?? NOOP_DISPOSER
        ))
      })
    })
  })
  // The daily check-in entry in the conversation header's action row. Its own
  // contribution, so a broken header seam cannot take the cards or the probe
  // control with it — and vice versa.
  guardClientContribution('conversation check-in entry', () => {
    ctx.slots.inject('conversation.session.header.actions', () => (
      guardClientContribution('conversation check-in entry', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'buddy-checkin-header',
        order: 20,
      }, BuddyCheckinPanel)) ?? NOOP_DISPOSER
    ))
  })
}
