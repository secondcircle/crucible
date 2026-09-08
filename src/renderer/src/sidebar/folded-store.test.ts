// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { localFoldedStore, memoryFoldedStore, type FoldedStore } from './folded-store'

const KEY = 'crucible.sidebar.folded'

function fakeStorage(seed: Record<string, string> = {}): Storage & {
  readonly held: Record<string, string>
} {
  const held: Record<string, string> = { ...seed }
  return {
    held,
    getItem: (key: string) => held[key] ?? null,
    setItem: (key: string, value: string) => {
      held[key] = value
    },
    removeItem: (key: string) => {
      delete held[key]
    },
    clear: () => {
      for (const key of Object.keys(held)) delete held[key]
    },
    key: (at: number) => Object.keys(held)[at] ?? null,
    get length() {
      return Object.keys(held).length
    }
  }
}

let storage: ReturnType<typeof fakeStorage>
let store: FoldedStore

beforeEach(() => {
  storage = fakeStorage()
  store = localFoldedStore(storage)
})

describe('what survives a relaunch', () => {
  it('reads back what the last launch folded', () => {
    store.write(new Set(['w1', 'w3']))

    expect([...localFoldedStore(storage).read()].sort()).toEqual(['w1', 'w3'])
  })

  it('replaces the record rather than adding to it', () => {
    store.write(new Set(['w1', 'w3']))
    store.write(new Set(['w2']))

    expect([...store.read()]).toEqual(['w2'])
  })

  it('names no path and holds only workspace ids', () => {
    store.write(new Set(['w1']))

    expect(JSON.parse(storage.held[KEY] ?? '')).toEqual({ version: 1, folded: ['w1'] })
  })

  it('keeps an id whose workspace no longer exists without complaint', () => {
    store.write(new Set(['w1', 'gone']))

    expect([...store.read()].sort()).toEqual(['gone', 'w1'])
  })
})

describe('a record this launch cannot use', () => {
  it('reads an absent one as nothing folded', () => {
    expect([...store.read()]).toEqual([])
  })

  it('reads malformed JSON as nothing folded', () => {
    storage.held[KEY] = '{ this is not json'

    expect([...store.read()]).toEqual([])
  })

  it('reads a version it does not know as nothing folded', () => {
    storage.held[KEY] = JSON.stringify({ version: 7, folded: ['w1'] })

    expect([...store.read()]).toEqual([])
  })

  it('reads a payload that is not a list of ids as nothing folded', () => {
    storage.held[KEY] = JSON.stringify({ version: 1, folded: { w1: true } })

    expect([...store.read()]).toEqual([])
  })

  it('drops entries that are not ids and keeps the rest', () => {
    storage.held[KEY] = JSON.stringify({ version: 1, folded: ['w1', 3, null] })

    expect([...store.read()]).toEqual(['w1'])
  })
})

describe('a store that cannot write', () => {
  it('swallows the failure, because nothing on screen waited on it', () => {
    const refusing = localFoldedStore({
      ...fakeStorage(),
      setItem: () => {
        throw new Error('this profile has no storage')
      }
    })

    expect(() => refusing.write(new Set(['w1']))).not.toThrow()
  })

  it('reads a storage that throws as nothing folded', () => {
    const refusing = localFoldedStore({
      ...fakeStorage(),
      getItem: () => {
        throw new Error('this profile has no storage')
      }
    })

    expect([...refusing.read()]).toEqual([])
  })
})

describe('where the launch keeps it', () => {
  it('is the window\u2019s own storage when none is handed in', () => {
    window.localStorage.clear()

    localFoldedStore().write(new Set(['w4']))

    expect(window.localStorage.getItem(KEY)).toBe(
      JSON.stringify({ version: 1, folded: ['w4'] })
    )
    expect([...localFoldedStore().read()]).toEqual(['w4'])
  })
})

describe('the store a component test hands in', () => {
  it('holds what was written and nothing from anywhere else', () => {
    const memory = memoryFoldedStore(['w2'])

    expect([...memory.read()]).toEqual(['w2'])
    memory.write(new Set(['w5']))
    expect([...memory.read()]).toEqual(['w5'])
  })
})
