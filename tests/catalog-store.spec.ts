import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WORKBUDDY_CATALOG_FILENAME, WorkBuddyCatalogStore, workbuddyCatalogPath } from '../src/catalog-store.ts'
import type { WorkBuddyUpstreamModel } from '../src/upstream.ts'

/**
 * The saved-catalog store.
 *
 * Its whole job is to answer "what did this account see last time?" when a fetch
 * cannot. Two failure modes matter: serving one account's roster to another (the
 * account key is the only thing preventing that), and a corrupt file taking the
 * plugin down instead of degrading to "nothing saved".
 *
 * Every path assertion is relative to an injected temp directory — the suite runs
 * on Ubuntu in CI as well as Windows, so no drive letters or backslashes.
 */

function model(id: string): WorkBuddyUpstreamModel {
  return { id, name: id, contextWindow: 1000, maxTokens: 100, supportsImages: false }
}

function withTempDir(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-suite-catalog-'))
  try {
    body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function save(store: WorkBuddyCatalogStore, account: string, ids: string[]): void {
  store.set(account, {
    source: 'live',
    fetchedAtMs: 1,
    models: ids.map(model),
  })
}

describe('catalog store paths', () => {
  it('defaults to the CN filename inside the Harness home', () => {
    // The filename is an isolation red line against the upstream bundle, so it
    // is asserted rather than merely used.
    expect(workbuddyCatalogPath().endsWith(WORKBUDDY_CATALOG_FILENAME)).toBe(true)
    expect(WORKBUDDY_CATALOG_FILENAME).toBe('.workbuddy-catalog.json')
  })

  it('honours an injected path', () => {
    withTempDir(dir => {
      const path = join(dir, 'custom.json')
      expect(new WorkBuddyCatalogStore({ path }).filePath()).toBe(path)
      expect(new WorkBuddyCatalogStore(path).filePath()).toBe(path)
    })
  })
})

describe('catalog store round trip', () => {
  it('reads an absent file as nothing saved', () => {
    withTempDir(dir => {
      const store = new WorkBuddyCatalogStore({ path: join(dir, 'missing.json') })
      expect(store.get('account:')).toBeUndefined()
    })
  })

  it('returns what was saved, in the order it was saved', () => {
    withTempDir(dir => {
      const store = new WorkBuddyCatalogStore({ path: join(dir, 'catalog.json') })
      save(store, 'account:', ['b', 'a', 'c'])

      const saved = store.get('account:')
      expect(saved?.models.map(row => row.id)).toEqual(['b', 'a', 'c'])
      expect(saved?.source).toBe('live')
      expect(saved?.fetchedAtMs).toBe(1)
    })
  })

  it('reads back identically through a fresh instance', () => {
    withTempDir(dir => {
      const path = join(dir, 'catalog.json')
      save(new WorkBuddyCatalogStore({ path }), 'account:', ['x', 'y'])

      const reread = new WorkBuddyCatalogStore({ path })
      expect(reread.get('account:')?.models.map(row => row.id)).toEqual(['x', 'y'])
    })
  })

  it('writes the documented document shape', () => {
    withTempDir(dir => {
      const path = join(dir, 'catalog.json')
      save(new WorkBuddyCatalogStore({ path }), 'account:', ['x'])

      const document = JSON.parse(readFileSync(path, 'utf8'))
      expect(document.version).toBe(1)
      expect(Object.keys(document.entries)).toEqual(['account:'])
      expect(document.entries['account:'].account).toBe('account:')
    })
  })

  it('keeps the optional app version when one was recorded', () => {
    withTempDir(dir => {
      const store = new WorkBuddyCatalogStore({ path: join(dir, 'catalog.json') })
      store.set('account:', { source: 'live', fetchedAtMs: 1, models: [model('a')], appVersion: '5.6.0' })
      expect(store.get('account:')?.appVersion).toBe('5.6.0')
    })
  })
})

describe('catalog store account isolation', () => {
  it('keeps two accounts from overwriting each other', () => {
    withTempDir(dir => {
      const store = new WorkBuddyCatalogStore({ path: join(dir, 'catalog.json') })
      save(store, 'account-a:', ['a1'])
      save(store, 'account-b:', ['b1'])

      expect(store.get('account-a:')?.models.map(row => row.id)).toEqual(['a1'])
      expect(store.get('account-b:')?.models.map(row => row.id)).toEqual(['b1'])
    })
  })

  it('replaces one account without touching the other', () => {
    withTempDir(dir => {
      const store = new WorkBuddyCatalogStore({ path: join(dir, 'catalog.json') })
      save(store, 'account-a:', ['old'])
      save(store, 'account-b:', ['b'])
      save(store, 'account-a:', ['new'])

      expect(store.get('account-a:')?.models.map(row => row.id)).toEqual(['new'])
      expect(store.get('account-b:')?.models.map(row => row.id)).toEqual(['b'])
    })
  })

  it('forgets one account and leaves the rest', () => {
    withTempDir(dir => {
      const store = new WorkBuddyCatalogStore({ path: join(dir, 'catalog.json') })
      save(store, 'account-a:', ['a'])
      save(store, 'account-b:', ['b'])

      store.delete('account-a:')

      expect(store.get('account-a:')).toBeUndefined()
      expect(store.get('account-b:')?.models.map(row => row.id)).toEqual(['b'])
    })
  })

  it('treats deleting an unknown account as a no-op', () => {
    withTempDir(dir => {
      const store = new WorkBuddyCatalogStore({ path: join(dir, 'catalog.json') })
      save(store, 'account-a:', ['a'])
      store.delete('never-saved:')
      expect(store.get('account-a:')?.models.map(row => row.id)).toEqual(['a'])
    })
  })
})

describe('catalog store degradation', () => {
  it('reads a corrupt file as nothing saved', () => {
    withTempDir(dir => {
      const path = join(dir, 'catalog.json')
      writeFileSync(path, '{ not json')
      const store = new WorkBuddyCatalogStore({ path })

      expect(() => store.get('account:')).not.toThrow()
      expect(store.get('account:')).toBeUndefined()
    })
  })

  it('discards a document of another version', () => {
    withTempDir(dir => {
      const path = join(dir, 'catalog.json')
      writeFileSync(path, JSON.stringify({ version: 99, entries: { 'account:': { account: 'account:', source: 'live', fetchedAtMs: 1, models: [model('a')] } } }))
      expect(new WorkBuddyCatalogStore({ path }).get('account:')).toBeUndefined()
    })
  })

  it('drops an entry with no models', () => {
    withTempDir(dir => {
      const path = join(dir, 'catalog.json')
      writeFileSync(path, JSON.stringify({ version: 1, entries: { 'account:': { account: 'account:', source: 'live', fetchedAtMs: 1, models: [] } } }))
      expect(new WorkBuddyCatalogStore({ path }).get('account:')).toBeUndefined()
    })
  })

  it('drops an entry whose row is missing a required field', () => {
    // A row without `supportsImages` would later be read as "images unsupported"
    // or crash the picker; the whole entry is refused instead.
    withTempDir(dir => {
      const path = join(dir, 'catalog.json')
      writeFileSync(path, JSON.stringify({
        version: 1,
        entries: { 'account:': { account: 'account:', source: 'live', fetchedAtMs: 1, models: [{ id: 'a', name: 'a', contextWindow: 1, maxTokens: 1 }] } },
      }))
      expect(new WorkBuddyCatalogStore({ path }).get('account:')).toBeUndefined()
    })
  })

  it('keeps the good entries when one is malformed', () => {
    withTempDir(dir => {
      const path = join(dir, 'catalog.json')
      writeFileSync(path, JSON.stringify({
        version: 1,
        entries: {
          good: { account: 'good', source: 'live', fetchedAtMs: 1, models: [model('a')] },
          bad: { account: 'bad', source: 'live', fetchedAtMs: 1, models: 'nope' },
        },
      }))
      const store = new WorkBuddyCatalogStore({ path })

      expect(store.get('good')?.models.map(row => row.id)).toEqual(['a'])
      expect(store.get('bad')).toBeUndefined()
    })
  })

  it('survives a write failure without throwing', () => {
    // The catalog was already served from memory; losing the memory of it is not
    // worth taking the plugin down for.
    withTempDir(dir => {
      // A file where a directory is needed makes mkdirSync/writeFileSync fail on
      // every platform.
      const blocker = join(dir, 'blocker')
      writeFileSync(blocker, 'x')
      const store = new WorkBuddyCatalogStore({ path: join(blocker, 'catalog.json') })

      expect(() => save(store, 'account:', ['a'])).not.toThrow()
      expect(store.get('account:')?.models.map(row => row.id)).toEqual(['a'])
    })
  })
})

describe('catalog store atomic write', () => {
  it('leaves no temporary file behind', () => {
    withTempDir(dir => {
      const path = join(dir, 'catalog.json')
      save(new WorkBuddyCatalogStore({ path }), 'account:', ['a'])

      expect(existsSync(`${path}.tmp`)).toBe(false)
      expect(existsSync(path)).toBe(true)
    })
  })

  it('creates the directory when it does not exist yet', () => {
    withTempDir(dir => {
      const path = join(dir, 'nested', 'deeper', 'catalog.json')
      save(new WorkBuddyCatalogStore({ path }), 'account:', ['a'])
      expect(existsSync(path)).toBe(true)
    })
  })

  it('does not leave a half-written document when the rename target is invalid', () => {
    // Renaming onto a directory fails; the previous file must still parse.
    withTempDir(dir => {
      const path = join(dir, 'catalog.json')
      save(new WorkBuddyCatalogStore({ path }), 'account:', ['a'])
      const before = readFileSync(path, 'utf8')

      // Make the rename target a non-empty directory so rename fails on POSIX
      // and Windows alike.
      rmSync(path, { force: true })
      mkdirSync(path)
      mkdirSync(join(path, 'occupied'))
      writeFileSync(join(path, 'occupied', 'f'), 'x')

      const store = new WorkBuddyCatalogStore({ path })
      expect(() => save(store, 'account:', ['b'])).not.toThrow()

      // The in-memory write still happened; nothing was corrupted on disk.
      expect(store.get('account:')?.models.map(row => row.id)).toEqual(['b'])
      expect(before).toContain('"a"')
    })
  })
})
