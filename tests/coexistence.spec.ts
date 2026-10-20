import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { WORKBUDDY_VARIANTS } from '../src/variants.ts'

/**
 * Coexistence with dsh-workbuddy-connect.
 *
 * Both bundles descend from the same model-provider lineage, and installing
 * both exposed three collisions that made the UI flip between them:
 *
 * - the Cordis patch node id (`llm-workbuddy`), which a profile indexes by id,
 *   so the later insert silently replaced the earlier one;
 * - the provider ids (`workbuddy` / `workbuddy-ai`), which the model registry
 *   holds once;
 * - two client-slot entry ids (`workbuddy-update`, `workbuddy-probe`) inside
 *   list slots the other bundle also fills.
 *
 * This bundle therefore namespaces its ids. These specs pin that, so a future
 * rename cannot quietly reintroduce the collision.
 *
 * The card variants are read from source rather than imported: that module is a
 * `.tsx` client file, and the host test project does not compile JSX.
 */

const root = fileURLToPath(new URL('..', import.meta.url))
const patch = readFileSync(`${root}cordis.patch.yml`, 'utf8')
const clientEntry = readFileSync(`${root}src/client/index.tsx`, 'utf8')
const cardSource = readFileSync(`${root}src/client/WorkBuddyPluginCard.tsx`, 'utf8')

/** Ids the other plugin is known to claim, from its own manifest and build. */
const OTHER_NODE_ID = 'llm-workbuddy'
const OTHER_PROVIDER_IDS = ['workbuddy', 'workbuddy-ai']
const OTHER_SLOT_IDS = ['workbuddy-update', 'workbuddy-probe']
/** State-file basenames the other plugin writes under `$DSH_HOME`. */
const OTHER_STATE_FILENAMES = ['.workbuddy-probe.json', '.workbuddy-ai-probe.json']

describe('cordis patch node id', () => {
  it('does not reuse the other bundle\'s node id', () => {
    // Two inserts with the same id mean the later one wins outright, which is
    // exactly the "sometimes my plugin, sometimes theirs" behaviour this fixes.
    const ids = [...patch.matchAll(/^\s*-\s*id:\s*(\S+)/gmu)].map(match => match[1])
    expect(ids.length).toBeGreaterThan(0)
    expect(ids).not.toContain(OTHER_NODE_ID)
    expect(ids).toContain('llm-workbuddy-suite')
  })
})

describe('provider ids', () => {
  it('namespaces both variants', () => {
    const ids = WORKBUDDY_VARIANTS.map(variant => variant.id)
    for (const id of ids) expect(id).toMatch(/-suite$/u)
  })

  it('collides with neither id the other bundle registers', () => {
    const ids = WORKBUDDY_VARIANTS.map(variant => variant.id)
    for (const other of OTHER_PROVIDER_IDS) expect(ids).not.toContain(other)
    // And the two variants must not collide with each other.
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps the card ids aligned with the provider ids', () => {
    // The composer's control resolves a selected provider through
    // `CARD_VARIANTS`, so a mismatch would point this card at the wrong routes.
    const cardIds = [...cardSource.matchAll(/^export const \w*CARD_VARIANT: WorkBuddyCardVariant = \{[\s\S]*?id: '([^']+)'/gmu)]
      .map(match => match[1])
    expect(cardIds.length).toBe(2)
    expect(cardIds.sort()).toEqual(WORKBUDDY_VARIANTS.map(variant => variant.id).sort())
  })
})

describe('client slot entry ids', () => {
  it('does not reuse the other bundle\'s slot entry ids', () => {
    for (const id of OTHER_SLOT_IDS) {
      expect(clientEntry).not.toContain(`id: '${id}'`)
    }
  })

  it('registers its own namespaced entry ids', () => {
    expect(clientEntry).toContain("id: 'workbuddy-suite-update'")
    expect(clientEntry).toContain("id: 'workbuddy-suite-probe'")
  })

  it('keeps the check-in entry id distinct', () => {
    // The check-in header entry exists only in this bundle, so its id is free —
    // but pinning it keeps the panel's registration identifiable.
    expect(clientEntry).toContain("id: 'buddy-checkin-header'")
  })
})

describe('probe state file names', () => {
  it('does not write the other bundle\'s state files', () => {
    // Sharing one probe-state file meant each bundle's records failed the
    // other's fingerprint check, so both silently discarded observations the
    // user had already paid for.
    for (const variant of WORKBUDDY_VARIANTS) {
      for (const other of OTHER_STATE_FILENAMES) {
        expect(variant.probeFilename).not.toBe(other)
      }
    }
  })
})
