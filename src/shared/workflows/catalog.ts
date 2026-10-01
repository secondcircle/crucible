// The workflow catalog: for a workspace, every workflow it can run, and for
// each one what a person needs to understand it without opening the file.
// Three kinds of fact meet here and each keeps its provenance: the manifest
// the engine read (description, inputs, target, commit, schedule, the plan's
// models), a model's reading of the file (summary, agents, prompts, stops,
// what comes back), and the run records (how past runs went). The renderer
// sees this module and the service shape; nothing behind them.

import type { Unsubscribe } from '../agent/port'
import type { CatalogReaderSettings } from './catalog-settings'
import type { QuoteSegment } from './source-scan'

/** Where a workflow file lives: the workspace's folder or the user's. */
export type WorkflowOrigin = 'user' | 'workspace'

/** The manifest's facts, as the engine read them from the file. */
export interface CatalogManifest {
  readonly description: string
  /** Input name → what to give it. */
  readonly inputs: Readonly<Record<string, string>>
  /** Absent means the engine's own default, which commits. */
  readonly commit?: boolean
  readonly target?: string | { readonly required: true }
  readonly schedule?: { readonly cron?: string; readonly checks: boolean }
}

/** One node `plan()` forecasts, as far as the catalog needs it: its id and model. */
export interface PlannedModel {
  readonly id: string
  readonly model?: string
}

/** Lines of a workflow's source, quoted exactly as they stood when they were read. */
export interface SourceQuote {
  /** Absolute path of the file the lines are in. */
  readonly file: string
  /** 1-based and inclusive. */
  readonly start: number
  readonly end: number
  readonly lines: readonly (readonly QuoteSegment[])[]
}

/** A prompt the reading found, by the name the file binds it to. */
export interface QuotedPrompt extends SourceQuote {
  readonly name: string
}

/** One agent a run of the workflow starts, as a role. */
export interface ReadAgent {
  readonly role: string
  /** The node ids it runs as; `<round>`-style holes stand for what varies. */
  readonly nodes: readonly string[]
  readonly does: string
  /** The model the file names for it; absent when it names none. */
  readonly model?: { readonly value: string; readonly quote: SourceQuote }
  readonly system?: QuotedPrompt
  readonly prompt?: QuotedPrompt
}

export interface ReadReturns {
  readonly artifacts: readonly { readonly file: string; readonly what: string }[]
  /** What the branch holds when the run ends; absent when it leaves none worth naming. */
  readonly branch?: string
  /** What the run reports back to its orchestrator. */
  readonly report: string
}

/** A model's reading of one workflow file, checked against the source before it was kept. */
export interface WorkflowReading {
  readonly reader: CatalogReaderSettings
  /** ISO. */
  readonly readAt: string
  readonly summary: string
  readonly agents: readonly ReadAgent[]
  /** How a run goes, in order, in prose. */
  readonly steps: readonly string[]
  /** When it stops to ask the human. Empty means it never does. */
  readonly stops: readonly string[]
  readonly returns: ReadReturns
}

// A reading in flight or failed keeps the last good one beside it, and the
// catalog only ever hands back a last reading by the reader now in force, so
// two readers' work is never on screen together.
export type ReadingState =
  | { readonly status: 'reading'; readonly last?: WorkflowReading }
  | { readonly status: 'read'; readonly reading: WorkflowReading }
  | { readonly status: 'failed'; readonly error: string; readonly last?: WorkflowReading }

export type CatalogEntry =
  | {
      readonly kind: 'workflow'
      readonly name: string
      readonly origin: WorkflowOrigin
      readonly path: string
      readonly manifest: CatalogManifest
      /** What `plan()` forecasts; absent when the file has none or it would not answer. */
      readonly plan?: readonly PlannedModel[]
      readonly reading: ReadingState
    }
  // A user workflow a workspace file of the same name wins over. Never read:
  // nothing can run it from this workspace.
  | {
      readonly kind: 'shadowed'
      readonly name: string
      readonly origin: 'user'
      readonly path: string
      /** The file that wins. */
      readonly winner: string
    }
  | {
      readonly kind: 'broken'
      readonly name: string
      readonly origin: WorkflowOrigin
      readonly path: string
      readonly error: string
    }

export interface WorkspaceCatalog {
  readonly workspacePath: string
  /** By name, the winner before what it shadows. */
  readonly entries: readonly CatalogEntry[]
}

// Only workspaces the catalog has been opened on appear, so a workspace with
// no entry is one nothing has been answered for yet.
export interface CatalogSnapshot {
  readonly reader: CatalogReaderSettings
  readonly workspaces: readonly WorkspaceCatalog[]
}

// The whole state after any change, like the schedule seam's: nothing is
// patched, so a dropped frame self-heals on the next one.
export type CatalogEvent = { readonly type: 'catalog'; readonly snapshot: CatalogSnapshot }

export type CatalogListener = (event: CatalogEvent) => void

export interface WorkflowCatalogService {
  snapshot(): Promise<CatalogSnapshot>
  /**
   * The workspace is on screen: its workflow folders are watched from now on,
   * and anything stale in it is read again. Resolves once it has been
   * surveyed, before any reading lands.
   */
  open(workspacePath: string): Promise<void>
  /** A new reader rereads every workflow in the background. */
  setReader(settings: CatalogReaderSettings): Promise<void>
  /** Live-only: no replay, no backlog. */
  onEvent(listener: CatalogListener): Unsubscribe
}

/** What main holds beyond the channel. */
export interface MainWorkflowCatalogService extends WorkflowCatalogService {
  dispose(): void
}

/** The workflow file and the local files it imports, as a reader is handed them. */
export interface WorkflowSourceFile {
  readonly path: string
  /** How the reader is told to cite it: relative to the workflow's folder. */
  readonly label: string
  readonly text: string
}

/** Everything a reader is given about one workflow. The first file is the workflow's own. */
export interface WorkflowReadRequest {
  readonly reader: CatalogReaderSettings
  readonly name: string
  readonly files: readonly WorkflowSourceFile[]
  readonly manifest: CatalogManifest
  readonly plan?: readonly PlannedModel[]
}

/** The reader's reply, unparsed: nothing it says is trusted until it is checked. */
export interface WorkflowReadAnswer {
  readonly reply: string
}
