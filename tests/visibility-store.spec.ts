import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WORKBUDDY_VISIBILITY_FILENAME, WorkBuddyVisibilityStore, workbuddyVisibilityPath } from '../src/visibility-store.ts'

/**
 * Per-account model visibility.
 *
 * Hiding a model is a preference the user set deliberately, so the store has two
 * asymmetries worth pinning: the account key must isolate preferences (otherwise
 * a second account silently inherits the first one's hidden models), and a failed
 * *write* propagates (answering "hidden" for a preference that did not persist is
 * worse than an error the card can report).
 *
 * Paths are always injected temp directories, for the Ubuntu CI leg.
 */

function withTempDir(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-suite-visibility-'))
  try {
    body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function tempStore(dir: string): WorkBuddyVisibilityStore {
  return new WorkBuddyVisibilityStore({ path: join(dir, 'visibility.json') })
}

describe('visibility store paths', () => {
  it('defaults to the CN filename inside the Harness home', () => {
    expect(workbuddyVisibilityPath().endsWith(WORKBUDDY_VISIBILITY_FILENAME)).toBe(true)
    expect(WORKBUDDY_VISIBILITY_FILENAME).toBe('.workbuddy-model-visibility.json')
  })

  it('honours an injected path', () => {
    withTempDir(dir => {
      const path = join(dir, 'custom.json')
      expect(new WorkBuddyVisibilityStore({ path }).filePath()).toBe(path)
      expect(new WorkBuddyVisibilityStore(path).filePath()).toBe(path)
    })
  })
})

describe('visibility store reads', () => {
  it('reports nothing hidden for an unknown account', () => {
    withTempDir(dir => {
      expect(tempStore(dir).disabled('account:')).toEqual([])
    })
  })

  it('reports nothing hidden when the file is corrupt', () => {
    withTempDir(dir => {
      const path = join(dir, 'visibility.json')
      writeFileSync(path, '<<<not json>>>')
      const store = new WorkBuddyVisibilityStore({ path })

      expect(() => store.disabled('account:')).not.toThrow()
      expect(store.disabled('account:')).toEqual([])
    })
  })

  it('discards a document of another version', () => {
    withTempDir(dir => {
      const path = join(dir, 'visibility.json')
      writeFileSync(path, JSON.stringify({ version: 42, accounts: { 'account:': { account: 'account:', disabled: ['glm-5.1'], updatedAtMs: 1 } } }))
      expect(new WorkBuddyVisibilityStore({ path }).disabled('account:')).toEqual([])
    })
  })

  it('drops an entry whose disabled list is not a list of ids', () => {
    withTempDir(dir => {
      const path = join(dir, 'visibility.json')
      writeFileSync(path, JSON.stringify({ version: 1, accounts: { 'account:': { account: 'account:', disabled: ['ok', 7], updatedAtMs: 1 } } }))
      expect(new WorkBuddyVisibilityStore({ path }).disabled('account:')).toEqual([])
    })
  })

  it('keeps the good accounts when one is malformed', () => {
    withTempDir(dir => {
      const path = join(dir, 'visibility.json')
      writeFileSync(path, JSON.stringify({
        version: 1,
        accounts: {
          good: { account: 'good', disabled: ['m'], updatedAtMs: 1 },
          bad: { account: 'bad', disabled: 'nope', updatedAtMs: 1 },
        },
      }))
      const store = new WorkBuddyVisibilityStore({ path })

      expect(store.disabled('good')).toEqual(['m'])
      expect(store.disabled('bad')).toEqual([])
    })
  })
})

describe('visibility store writes', () => {
  it('hides a model and reports it back', () => {
    withTempDir(dir => {
      const store = tempStore(dir)
      store.setVisible('account:', 'glm-5.1', false)
      expect(store.disabled('account:')).toEqual(['glm-5.1'])
    })
  })

  it('shows a hidden model again', () => {
    withTempDir(dir => {
      const store = tempStore(dir)
      store.setVisible('account:', 'glm-5.1', false)
      store.setVisible('account:', 'glm-5.1', true)
      expect(store.disabled('account:')).toEqual([])
    })
  })

  it('is idempotent when hiding the same model twice', () => {
    withTempDir(dir => {
      const store = tempStore(dir)
      store.setVisible('account:', 'glm-5.1', false)
      store.setVisible('account:', 'glm-5.1', false)
      expect(store.disabled('account:')).toEqual(['glm-5.1'])
    })
  })

  it('is idempotent when showing a visible model twice', () => {
    withTempDir(dir => {
      const store = tempStore(dir)
      store.setVisible('account:', 'glm-5.1', true)
      store.setVisible('account:', 'glm-5.1', true)
      expect(store.disabled('account:')).toEqual([])
    })
  })

  it('removes the account bucket once nothing is hidden', () => {
    // An absent entry and an empty list mean the same thing, and the file should
    // not accumulate empty buckets.
    withTempDir(dir => {
      const path = join(dir, 'visibility.json')
      const store = new WorkBuddyVisibilityStore({ path })
      store.setVisible('account:', 'glm-5.1', false)
      store.setVisible('account:', 'glm-5.1', true)

      const document = JSON.parse(readFileSync(path, 'utf8'))
      expect(document.accounts).toEqual({})
    })
  })

  it('keeps two accounts from sharing preferences', () => {
    withTempDir(dir => {
      const store = tempStore(dir)
      store.setVisible('account-a:', 'glm-5.1', false)

      expect(store.disabled('account-a:')).toEqual(['glm-5.1'])
      expect(store.disabled('account-b:')).toEqual([])
    })
  })

  it('keeps hidden ids for an account that signs out and back in', () => {
    withTempDir(dir => {
      const path = join(dir, 'visibility.json')
      new WorkBuddyVisibilityStore({ path }).setVisible('account:', 'm', false)

      // A fresh instance models a restart: entries survive sign-out by design.
      expect(new WorkBuddyVisibilityStore({ path }).disabled('account:')).toEqual(['m'])
    })
  })

  it('writes the documented document shape', () => {
    withTempDir(dir => {
      const path = join(dir, 'visibility.json')
      tempStore(dir).setVisible('account:', 'm', false)

      const document = JSON.parse(readFileSync(path, 'utf8'))
      expect(document.version).toBe(1)
      expect(document.accounts['account:'].account).toBe('account:')
      expect(document.accounts['account:'].disabled).toEqual(['m'])
      expect(typeof document.accounts['account:'].updatedAtMs).toBe('number')
    })
  })

  it('creates the directory when it does not exist yet', () => {
    withTempDir(dir => {
      const path = join(dir, 'nested', 'child', 'visibility.json')
      new WorkBuddyVisibilityStore({ path }).setVisible('account:', 'm', false)
      expect(existsSync(path)).toBe(true)
    })
  })

  it('leaves no temporary file behind', () => {
    withTempDir(dir => {
      const path = join(dir, 'visibility.json')
      tempStore(dir).setVisible('account:', 'm', false)
      expect(existsSync(`${path}.tmp`)).toBe(false)
    })
  })
})

describe('visibility store write failures', () => {
  it('throws when the preference cannot be persisted', () => {
    // The card reports this rather than claiming a toggle was saved.
    withTempDir(dir => {
      const blocker = join(dir, 'blocker')
      writeFileSync(blocker, 'x')
      const store = new WorkBuddyVisibilityStore({ path: join(blocker, 'visibility.json') })

      expect(() => store.setVisible('account:', 'm', false)).toThrow()
    })
  })

  it('leaves in-memory state untouched after a failed write', () => {
    // A re-read must not be able to lie about what was persisted.
    withTempDir(dir => {
      const blocker = join(dir, 'blocker')
      writeFileSync(blocker, 'x')
      const store = new WorkBuddyVisibilityStore({ path: join(blocker, 'visibility.json') })

      expect(() => store.setVisible('account:', 'm', false)).toThrow()
      expect(store.disabled('account:')).toEqual([])
    })
  })
})
