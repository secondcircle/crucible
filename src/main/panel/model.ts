import { existsSync, statSync } from 'node:fs'
import { open as openFile, readFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import type { PanelTools } from '../../shared/agent/panel-tools'
import type {
  ExhibitKind,
  PanelState,
  PanelTab,
  SessionId,
  TabId,
  Unsubscribe
} from '../../shared/agent/port'

// Both adapters delegate here, so a fake-flavor panel and an SDK-flavor panel
// cannot mean different things. Persistence is an argument for the same reason.

/** A tab as it is persisted, path and turn included. */
export interface StoredPanelTab {
  readonly id: TabId
  readonly title: string
  /** Absolute, resolved at show time; the dedupe key. */
  readonly path: string
  readonly kind: ExhibitKind
  /** ISO of the latest show. */
  readonly shownAt: string
  /** The session's turn counter at the latest show. */
  readonly shownTurn: number
  /** Present for a binary tab alone, which shows its size and no contents. */
  readonly bytes?: number
  /** Present for a source tab whose file has a rendered view to flip to. */
  readonly renders?: 'markdown' | 'html'
}

export interface StoredPanel {
  /** Show order, oldest first. */
  readonly tabs: readonly StoredPanelTab[]
  readonly activeTabId: TabId | null
  /** The session's preview tab; `null` when it has none. */
  readonly previewTabId: TabId | null
  /** Monotonic within the session; drives "shown N turns ago". */
  readonly turn: number
}

// Where a session's panel is kept between launches. The shell store is what
// implements this in the app; a test hands in a map.
export interface PanelPersistence {
  load(sessionId: SessionId): StoredPanel | undefined
  save(sessionId: SessionId, panel: StoredPanel): void
}

// Persistence that lasts one process: what a test and the one-shot SDK proof
// want, since neither has a store to write into.
export function memoryPanelPersistence(): PanelPersistence {
  const held = new Map<SessionId, StoredPanel>()
  return {
    load: (sessionId) => held.get(sessionId),
    save: (sessionId, panel) => {
      held.set(sessionId, panel)
    }
  }
}

export interface PanelChange {
  readonly sessionId: SessionId
  /** Present when the change was a show: the tab shown or refreshed. */
  readonly shownTabId?: TabId
}

export type PanelChangeListener = (change: PanelChange) => void

export interface PanelModel extends PanelTools {
  // A click in the file tree, which shows anything a folder holds rather than
  // the three kinds an agent may show. `keep: false` is the single click: it
  // reuses the session's preview tab, in place. Answers the tab's id.
  open(
    sessionId: SessionId,
    directory: string,
    path: string,
    options: { readonly keep: boolean }
  ): Promise<TabId>
  // The tab's source/rendered toggle. Flipping a tab that has no rendered
  // view, or one that is already shown that way, changes nothing.
  setSource(sessionId: SessionId, tabId: TabId, source: boolean): void
  /** What crosses the port. Absent when the session has no tabs. */
  state(sessionId: SessionId): PanelState | undefined
  /** The user's click. An unknown id is a silent no-op. */
  activate(sessionId: SessionId, tabId: TabId): void
  /** The user's ×: `panel_close` semantics without a result text. */
  closeTab(sessionId: SessionId, tabId: TabId): void
  /** The exhibit's body, read at call time. Rejects when it cannot be read. */
  exhibit(sessionId: SessionId, tabId: TabId): Promise<string>
  /** Once per user instruction; drives "shown N turns ago" ages. */
  bumpTurn(sessionId: SessionId): void
  /** A session reset: a fresh conversation never inherits a ghost panel. */
  reset(sessionId: SessionId): void
  /** The session is gone; its panel goes with it. */
  forget(sessionId: SessionId): void
  onChange(listener: PanelChangeListener): Unsubscribe
}

interface Tab {
  readonly id: TabId
  title: string
  readonly path: string
  kind: ExhibitKind
  shownAt: string
  shownTurn: number
  bytes?: number
  renders?: 'markdown' | 'html'
}

interface Panel {
  tabs: Tab[]
  activeTabId: TabId | null
  previewTabId: TabId | null
  turn: number
}

const SUPPORTED = '.html, .htm, .md, .markdown, .txt, or an http(s) URL'

/** Shown as an image; everything else that is not text shows its size. */
const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.avif',
  '.svg'
])

/** Enough of a file to tell text from bytes, and little enough to be free. */
const SNIFF_BYTES = 4096

export function createPanelModel({
  persistence,
  now = () => new Date()
}: {
  readonly persistence: PanelPersistence
  /** The clock, so a test can pin what `shownAt` says. */
  readonly now?: () => Date
}): PanelModel {
  const panels = new Map<SessionId, Panel>()
  const listeners = new Set<PanelChangeListener>()

  function notify(change: PanelChange): void {
    // A copy, so a listener that unsubscribes while being called does not
    // disturb the delivery of that same change to the others.
    for (const listener of [...listeners]) listener(change)
  }

  function stored(panel: Panel): StoredPanel {
    return {
      tabs: panel.tabs.map((tab) => ({ ...tab })),
      activeTabId: panel.activeTabId,
      previewTabId: panel.previewTabId,
      turn: panel.turn
    }
  }

  function persist(sessionId: SessionId, panel: Panel): void {
    persistence.save(sessionId, stored(panel))
  }

  // The active tab is always one of the tabs, and closing the active one falls
  // to the last in show order, which is where the eye already is.
  function reseat(panel: Panel): void {
    // A preview tab that has left is no longer the preview tab: the field can
    // only ever name a tab that is open.
    if (!panel.tabs.some((tab) => tab.id === panel.previewTabId)) panel.previewTabId = null
    if (panel.tabs.some((tab) => tab.id === panel.activeTabId)) return
    panel.activeTabId = panel.tabs.at(-1)?.id ?? null
  }

  // A restored tab whose file is gone is dropped rather than resurrected, so
  // no snapshot ever offers an exhibit that cannot be read.
  function panelOf(sessionId: SessionId): Panel {
    const already = panels.get(sessionId)
    if (already !== undefined) return already

    const loaded = persistence.load(sessionId)
    const panel: Panel = {
      tabs: (loaded?.tabs ?? []).map((tab) => ({ ...tab })),
      activeTabId: loaded?.activeTabId ?? null,
      previewTabId: loaded?.previewTabId ?? null,
      turn: loaded?.turn ?? 0
    }
    const held = panel.tabs.length
    // A url tab has no file to be gone; it is kept and loads live.
    panel.tabs = panel.tabs.filter((tab) => tab.kind === 'url' || onDisk(tab.path))
    reseat(panel)
    panels.set(sessionId, panel)
    // Written back at once when something was dropped, so the store stops
    // holding a path that leads nowhere.
    if (panel.tabs.length !== held) persist(sessionId, panel)
    return panel
  }

  function age(panel: Panel, tab: Tab): string {
    const turns = panel.turn - tab.shownTurn
    if (turns <= 0) return 'this turn'
    if (turns === 1) return '1 turn ago'
    return `${turns} turns ago`
  }

  function tabList(panel: Panel): string {
    return panel.tabs
      .map((tab, index) => `  ${index + 1}. ${tab.id} — "${tab.title}" (shown ${age(panel, tab)})`)
      .join('\n')
  }

  function listResult(panel: Panel): string {
    if (panel.tabs.length === 0) return 'The context panel is empty.'
    return `Open tabs in the context panel:\n${tabList(panel)}`
  }

  // More than one tab open and the whole list rides along with the nudge:
  // that is the curation pressure, applied just in time.
  function showResult(panel: Panel, shown: Tab): string {
    if (panel.tabs.length <= 1) return `Shown in context panel: "${shown.title}"`
    return [
      `Shown in context panel: "${shown.title}"`,
      `Open tabs:\n${tabList(panel)}`,
      'Close tabs that are no longer relevant to the current conversation.'
    ].join('\n')
  }

  function findTab(sessionId: SessionId, tabId: TabId): Tab | undefined {
    return panelOf(sessionId).tabs.find((tab) => tab.id === tabId)
  }

  return {
    show(sessionId: SessionId, workspacePath: string, path: string, title: string): string {
      // A web address is a tab too: it loads live, straight off its server.
      const web = isWebAddress(path)
      const resolved = web ? path : isAbsolute(path) ? path : resolve(workspacePath, path)
      if (!web && !onDisk(resolved)) throw new Error(`File not found: ${resolved}`)
      const kind = web ? 'url' : detectKind(resolved)

      const panel = panelOf(sessionId)
      // Keyed by path: re-showing a file refreshes its tab in place and mints
      // neither a second tab nor a second id.
      const already = panel.tabs.find((tab) => tab.path === resolved)
      let shown: Tab
      if (already !== undefined) {
        already.title = title
        already.kind = kind
        already.shownAt = now().toISOString()
        already.shownTurn = panel.turn
        shown = already
      } else {
        shown = {
          id: mintId(panel, resolved),
          title,
          path: resolved,
          kind,
          shownAt: now().toISOString(),
          shownTurn: panel.turn
        }
        panel.tabs.push(shown)
      }
      panel.activeTabId = shown.id
      // A tab the agent showed is never the preview tab: the agent curates its
      // own tabs, and a click elsewhere in the tree must not take one away.
      if (panel.previewTabId === shown.id) panel.previewTabId = null
      persist(sessionId, panel)
      notify({ sessionId, shownTabId: shown.id })
      return showResult(panel, shown)
    },

    async open(
      sessionId: SessionId,
      directory: string,
      path: string,
      { keep }: { readonly keep: boolean }
    ): Promise<TabId> {
      const resolved = isAbsolute(path) ? path : resolve(directory, path)
      if (!onDisk(resolved)) throw new Error(`File not found: ${resolved}`)
      const kind = await openedKind(resolved)

      const panel = panelOf(sessionId)
      const already = panel.tabs.find((tab) => tab.path === resolved)
      const renders = rendersOf(resolved)
      let shown: Tab
      if (already !== undefined) {
        // Landing on a tab that is open leaves how it is being shown alone: a
        // click in the tree is not an opinion about the agent's rendered view,
        // or about the toggle the user just used.
        already.shownAt = now().toISOString()
        already.shownTurn = panel.turn
        if (already.kind === 'binary') already.bytes = sizeOf(resolved)
        shown = already
        // A double-click keeps the file it lands on, whether the click before
        // it opened the tab or the agent did.
        if (keep && panel.previewTabId === shown.id) panel.previewTabId = null
      } else {
        shown = {
          id: mintId(panel, resolved),
          title: basename(resolved),
          path: resolved,
          kind,
          shownAt: now().toISOString(),
          shownTurn: panel.turn,
          ...(kind === 'binary' ? { bytes: sizeOf(resolved) } : {}),
          ...(kind === 'source' && renders !== undefined ? { renders } : {})
        }
        // The preview tab is one slot: the next single click puts another file
        // in it, where the eye already is, rather than beside it.
        const previewAt = panel.tabs.findIndex((tab) => tab.id === panel.previewTabId)
        if (!keep && previewAt !== -1) panel.tabs.splice(previewAt, 1, shown)
        else panel.tabs.push(shown)
        panel.previewTabId = keep ? panel.previewTabId : shown.id
      }
      panel.activeTabId = shown.id
      reseat(panel)
      persist(sessionId, panel)
      notify({ sessionId, shownTabId: shown.id })
      return shown.id
    },

    list(sessionId: SessionId): string {
      return listResult(panelOf(sessionId))
    },

    close(sessionId: SessionId, id: string): string {
      const panel = panelOf(sessionId)
      if (id === 'all') {
        panel.tabs = []
        panel.activeTabId = null
        panel.previewTabId = null
        persist(sessionId, panel)
        notify({ sessionId })
        return 'Closed all tabs. The context panel is empty.'
      }
      const at = panel.tabs.findIndex((tab) => tab.id === id)
      // The current list rides along with the refusal, so the agent learns
      // what is actually open from the same answer.
      if (at === -1) throw new Error(`No tab with id "${id}". ${listResult(panel)}`)
      const [closed] = panel.tabs.splice(at, 1)
      reseat(panel)
      persist(sessionId, panel)
      notify({ sessionId })
      return `Closed "${closed.title}". ${listResult(panel)}`
    },

    state(sessionId: SessionId): PanelState | undefined {
      const panel = panelOf(sessionId)
      const activeTabId = panel.activeTabId
      if (panel.tabs.length === 0 || activeTabId === null) return undefined
      return {
        tabs: panel.tabs.map(crossing),
        activeTabId,
        ...(panel.previewTabId === null ? {} : { previewTabId: panel.previewTabId })
      }
    },

    setSource(sessionId: SessionId, tabId: TabId, source: boolean): void {
      const panel = panelOf(sessionId)
      const tab = panel.tabs.find((open) => open.id === tabId)
      if (tab === undefined) return
      if (source) {
        if (tab.kind !== 'markdown' && tab.kind !== 'html') return
        // The kind it came from is the kind it goes back to, which is what
        // makes the toggle reversible without a second field to keep in step.
        tab.renders = tab.kind
        tab.kind = 'source'
      } else {
        if (tab.kind !== 'source' || tab.renders === undefined) return
        tab.kind = tab.renders
      }
      persist(sessionId, panel)
      notify({ sessionId })
    },

    activate(sessionId: SessionId, tabId: TabId): void {
      const panel = panelOf(sessionId)
      // The agent may have closed it while the click was in flight, and a
      // click at nothing is not an error.
      if (!panel.tabs.some((tab) => tab.id === tabId)) return
      if (panel.activeTabId === tabId) return
      panel.activeTabId = tabId
      persist(sessionId, panel)
      notify({ sessionId })
    },

    closeTab(sessionId: SessionId, tabId: TabId): void {
      const panel = panelOf(sessionId)
      const at = panel.tabs.findIndex((tab) => tab.id === tabId)
      if (at === -1) return
      panel.tabs.splice(at, 1)
      reseat(panel)
      persist(sessionId, panel)
      // Nothing is pushed at the agent: it learns the state at its next
      // panel_list or panel_show, both computed from live state.
      notify({ sessionId })
    },

    // The agent chose this path through `panel_show`, so its size is the
    // agent's and nothing caps it. Read off the loop: an 18 MB exhibit used to
    // hold the window for the whole read, and a 500 MB one would hold it far
    // longer.
    async exhibit(sessionId: SessionId, tabId: TabId): Promise<string> {
      const tab = findTab(sessionId, tabId)
      if (tab === undefined) throw new Error('That tab is no longer in the context panel.')
      if (tab.kind === 'url') {
        throw new Error('That tab shows a web address; it has no file to read.')
      }
      if (tab.kind === 'image' || tab.kind === 'binary') {
        throw new Error('That tab shows a file that is not text; it has no body to read.')
      }
      try {
        return await readFile(tab.path, 'utf8')
      } catch {
        // The tab stays open whatever this says: curation is the agent's.
        throw new Error(`That exhibit could not be read: ${basename(tab.path)}`)
      }
    },

    bumpTurn(sessionId: SessionId): void {
      const panel = panelOf(sessionId)
      panel.turn += 1
      // Persisted but not announced: ages live in tool result texts, and
      // nothing the user can see has changed.
      persist(sessionId, panel)
    },

    reset(sessionId: SessionId): void {
      const panel = panelOf(sessionId)
      panel.tabs = []
      panel.activeTabId = null
      panel.previewTabId = null
      panel.turn = 0
      persist(sessionId, panel)
      notify({ sessionId })
    },

    forget(sessionId: SessionId): void {
      // Only the memory of it: the persisted copy leaves with the session
      // record it was stored in.
      panels.delete(sessionId)
    },

    onChange(listener: PanelChangeListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

function crossing(tab: Tab): PanelTab {
  const carried = { id: tab.id, title: tab.title, shownAt: tab.shownAt }
  if (tab.kind === 'url') return { ...carried, kind: 'url', address: tab.path }
  if (tab.kind === 'html') return { ...carried, kind: 'html', path: tab.path }
  if (tab.kind === 'source') {
    return {
      ...carried,
      kind: 'source',
      path: tab.path,
      ...(tab.renders === undefined ? {} : { renders: tab.renders })
    }
  }
  if (tab.kind === 'image') return { ...carried, kind: 'image', path: tab.path }
  if (tab.kind === 'binary') {
    return { ...carried, kind: 'binary', path: tab.path, bytes: tab.bytes ?? 0 }
  }
  return { ...carried, kind: 'markdown', path: tab.path }
}

function onDisk(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

// What a click in the tree lands on. Total, unlike the agent's: a folder holds
// pictures and object files too, and a viewer that refused them would send the
// user back to the Finder.
// Everything opens as source; what has a rendered view carries the toggle to
// it instead of opening there.
async function openedKind(path: string): Promise<ExhibitKind> {
  if (IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) return 'image'
  return (await looksBinary(path)) ? 'binary' : 'source'
}

/** The view a source tab's file can be flipped to, when it has one. */
function rendersOf(path: string): 'markdown' | 'html' | undefined {
  const extension = extname(path).toLowerCase()
  if (extension === '.html' || extension === '.htm') return 'html'
  if (extension === '.md' || extension === '.markdown') return 'markdown'
  return undefined
}

// A NUL byte in the head of a file is what every diff tool takes for "not
// text", and it costs one short read rather than a decode of the whole file.
async function looksBinary(path: string): Promise<boolean> {
  let handle
  try {
    handle = await openFile(path, 'r')
    const head = Buffer.alloc(SNIFF_BYTES)
    const { bytesRead } = await handle.read(head, 0, SNIFF_BYTES, 0)
    return head.subarray(0, bytesRead).includes(0)
  } catch {
    return false
  } finally {
    await handle?.close()
  }
}

function detectKind(path: string): ExhibitKind {
  const extension = extname(path).toLowerCase()
  if (extension === '.html' || extension === '.htm') return 'html'
  if (extension === '.md' || extension === '.markdown' || extension === '.txt') return 'markdown'
  throw new Error(`Unsupported file type "${extension}". Supported: ${SUPPORTED}`)
}

function isWebAddress(path: string): boolean {
  return /^https?:\/\//i.test(path)
}

// For a URL, its host; the last path piece when one exists. So
// `http://localhost:5173/` mints `localhost` and stays readable in a result.
function nameOf(path: string): string {
  if (!isWebAddress(path)) return basename(path).replace(/\.[^.]+$/, '')
  try {
    const url = new URL(path)
    const piece = url.pathname.split('/').filter((part) => part !== '').at(-1)
    return piece ?? url.hostname
  } catch {
    return 'page'
  }
}

// The basename without its extension, slugged. Collisions take -2, -3, … so a
// tab id stays a name a person can read back in a tool result.
function mintId(panel: Panel, path: string): TabId {
  const base =
    nameOf(path)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'tab'
  let id = base
  for (let n = 2; panel.tabs.some((tab) => tab.id === id); n += 1) id = `${base}-${n}`
  return id
}
