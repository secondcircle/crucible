import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MODEL_ALIASES } from '../../../shared/agent/known-models'
import type { ModelInfo, SessionWorktree, ThinkingLevel } from '../../../shared/agent/port'
import type { CommandInfo } from '../../../shared/commands/service'
import { commandFragment, filterCommands } from '../../../shared/commands/template'
import { worktreeLabel } from '../labels'
import { boxHeight } from './composer-height'
import './composer.css'

// The textarea stays editable while the session works so the next instruction
// can be drafted. Escape has an app-wide precedence this component cannot see.

/** An image waiting to be sent with the next prompt. */
export interface Attachment {
  readonly id: string
  /** The file's own name, which is what an error has to be able to name. */
  readonly name: string
  readonly mimeType: string
  readonly data: string
}

/** The token under the caret, or nothing when the caret is not in one. */
const FILE_TOKEN = /@([\w./-]*)$/

const FILE_ROWS = 7

const COMMAND_ROWS = 7

/** Any number of leading `!` is the same grammar, so `!!` never differs. */
function bashCommandOf(draft: string): string | undefined {
  if (!draft.startsWith('!')) return undefined
  return draft.replace(/^!+/, '').trim()
}

// A glyph and a branch name read as neither on their own, so the accessible
// name says where the session works in full, in the two words CONTEXT.md
// defines: the checkout, or a worktree.
function worktreeChipLabel(worktree: SessionWorktree | undefined, busy: boolean): string {
  if (worktree === undefined) {
    return busy ? 'Creating a worktree…' : 'This session works in the checkout'
  }
  return `This session works in worktree ${worktreeLabel(worktree)}`
}

/** What an origin badge says, in Crucible's own words for the three origins. */
const ORIGIN_LABEL: Record<CommandInfo['origin'], string> = {
  workspace: 'workspace',
  user: 'user',
  'built-in': 'built-in'
}

export function Composer({
  draft,
  disabled,
  working,
  elapsedSeconds,
  model,
  modelId,
  models,
  modelPickerOpen,
  thinkingLevel,
  thinkingMenuOpen,
  attachments,
  files,
  commands,
  workspaceName,
  sessionDirectory,
  worktree,
  worktreeShown,
  worktreeBusy,
  worktreeLocked,
  worktreeOutput,
  boxRef,
  onDraft,
  onSend,
  onFollowUp,
  onRestoreLast,
  onStop,
  onToggleModelPicker,
  onSelectModel,
  onToggleThinkingMenu,
  onSelectThinkingLevel,
  onRemoveAttachment,
  onFileToken,
  onRunBash,
  onToggleWorktree
}: {
  readonly draft: string
  /** No workspace or no session: the composer is present but not usable. */
  readonly disabled: boolean
  readonly working: boolean
  readonly elapsedSeconds?: number
  readonly model?: ModelInfo
  readonly modelId?: string
  readonly models: readonly ModelInfo[]
  readonly modelPickerOpen: boolean
  readonly thinkingLevel?: ThinkingLevel
  readonly thinkingMenuOpen: boolean
  /** Images attached to this session's draft, in the order they arrived. */
  readonly attachments: readonly Attachment[]
  /** The file popover's results; absent means the popover is closed. */
  readonly files?: readonly string[]
  // Every command this workspace can reach, winners only. Absent means the
  // list has not been read yet, which is not the same as an empty folder.
  readonly commands?: readonly CommandInfo[]
  readonly workspaceName?: string
  /** Where a bash run starts: the session's worktree, or its checkout. */
  readonly sessionDirectory?: string
  /** Present only for a worktree session; absent means the checkout. */
  readonly worktree?: SessionWorktree
  /** False for a workspace that is not a git working tree: no chip at all. */
  readonly worktreeShown: boolean
  /** A creation, or the rebind a flip back needs, is under way. */
  readonly worktreeBusy: boolean
  /** Past its first message: the chip keeps its label and stops being one. */
  readonly worktreeLocked: boolean
  /** The last failed attempt's output; transient, and never stored. */
  readonly worktreeOutput?: string
  /** Held above, because what restores a queued message also focuses it. */
  readonly boxRef?: React.RefObject<HTMLTextAreaElement | null>
  readonly onDraft: (draft: string) => void
  /** Enter: a prompt while idle, a steering message while working. */
  readonly onSend: () => void
  /** Option+Enter: a follow-up while working, and a plain send while idle. */
  readonly onFollowUp: () => void
  /** Option+Up: π's binding for pulling the last queued message back. */
  readonly onRestoreLast: () => void
  readonly onStop: () => void
  readonly onToggleModelPicker: () => void
  readonly onSelectModel: (id: string) => void
  readonly onToggleThinkingMenu: () => void
  readonly onSelectThinkingLevel: (level: ThinkingLevel) => void
  readonly onRemoveAttachment: (id: string) => void
  // What the caret is looking at: a token opens the file popover, nothing
  // closes it. The search itself is the workspace service's, never the port's.
  readonly onFileToken: (token?: string) => void
  readonly onRunBash: (command: string) => void
  /** Checkout to a new worktree, or a worktree back to the checkout. */
  readonly onToggleWorktree: () => void
}): React.JSX.Element {
  // The selection belongs to one result list: a fresh list is looked at from
  // the top rather than from wherever the last one had been left.
  const [selection, setSelection] = useState<{
    readonly of?: readonly string[]
    readonly at: number
  }>({ at: 0 })
  // The command popover's selection is its own: a fresh set of rows is looked
  // at from the top.
  const [commandAt, setCommandAt] = useState<{ readonly of?: string; readonly at: number }>({
    at: 0
  })
  const command = bashCommandOf(draft)
  const bash = command !== undefined
  const shown = (files ?? []).slice(0, FILE_ROWS)
  const filesOpen = files !== undefined && !bash
  const selected = selection.of === files ? selection.at : 0

  // The first character decides which grammar the draft is in, and nothing
  // else does.
  const commandMode = draft.startsWith('/')
  const fragment = commandFragment(draft)
  const matches =
    fragment === undefined || commands === undefined
      ? undefined
      : filterCommands(commands, fragment).slice(0, COMMAND_ROWS)
  const commandSelected = commandAt.of === fragment ? commandAt.at : 0

  // The text area is held here and handed up: what restores a queued message
  // also focuses it, and the sizing below has to measure it.
  const box = useRef<HTMLTextAreaElement | null>(null)
  const mirror = useRef<HTMLDivElement>(null)
  const holdBox = useCallback(
    (node: HTMLTextAreaElement | null): void => {
      box.current = node
      if (boxRef !== undefined) boxRef.current = node
    },
    [boxRef]
  )

  // Measured on the mirror rather than on the text area itself: measuring the
  // text area means collapsing it first to read its scrollHeight, and a
  // collapse the browser has laid out is a height the transition then
  // animates from.
  useLayoutEffect(() => {
    const node = box.current
    if (node === null) return
    node.style.height = `${boxHeight(mirror.current?.scrollHeight ?? 0)}px`
  }, [draft, bash, commandMode])

  function select(at: number): void {
    setSelection({ of: files, at })
  }

  function selectCommand(at: number): void {
    setCommandAt({ of: fragment, at })
  }

  // Nothing is sent and nothing is expanded here: the name goes into the draft
  // with the space the arguments follow.
  function insertCommand(name: string): void {
    onDraft(`/${name} `)
    box.current?.focus()
  }

  // The alias when Crucible knows this id by heart, and the port's own label
  // otherwise. Display only: the picker below lists what the port reported.
  const chipName =
    modelId === undefined ? undefined : (MODEL_ALIASES[modelId] ?? model?.label ?? modelId)

  // Sending and queueing ask the same question of a draft: some text, and a
  // session settled enough to answer it.
  //
  // Nothing is sent while a worktree is being made: the directory the message
  // would be answered in is not settled yet.
  const sendable = !disabled && draft.trim() !== '' && !worktreeBusy
  const runnable = !disabled && command !== undefined && command !== ''

  // Read from the element rather than from the draft prop: a keystroke is
  // already in the textarea when this runs and has not come back down yet.
  function look(box: HTMLTextAreaElement | null): void {
    if (box === null || box.value.startsWith('!')) {
      onFileToken(undefined)
      return
    }
    const found = FILE_TOKEN.exec(box.value.slice(0, box.selectionStart ?? box.value.length))
    onFileToken(found === null ? undefined : (found[1] ?? ''))
  }

  // Plain text in the draft, matching π: nothing is attached and nothing is
  // read.
  function insertPath(path: string): void {
    const node = box.current
    const caret = node === null ? draft.length : (node.selectionStart ?? draft.length)
    const before = draft.slice(0, caret).replace(FILE_TOKEN, `@${path} `)
    onDraft(before + draft.slice(caret))
    onFileToken(undefined)
    node?.focus()
  }

  function run(): void {
    if (!runnable || command === undefined) return
    onRunBash(command)
  }

  return (
    <div className="composer">
      {matches === undefined ? null : (
        <div className="cmdpop" role="listbox" aria-label="Commands">
          <div className="pophead">
            Commands — type to filter, ⏎ inserts the name
          </div>
          {matches.length === 0 ? (
            <div className="popempty">No command matches "{fragment}"</div>
          ) : (
            matches.map((found, index) => (
              <button
                key={`${found.origin}:${found.name}`}
                className={`cmdrow${index === commandSelected ? ' sel' : ''}`}
                role="option"
                aria-selected={index === commandSelected}
                onMouseDown={(clicked) => clicked.preventDefault()}
                onClick={() => insertCommand(found.name)}
              >
                <span className="cname">/{found.name}</span>
                {found.argumentHint === undefined ? null : (
                  <span className="cargs">{found.argumentHint}</span>
                )}
                <span className="cdesc">{found.description}</span>
                <span className={`scope ${found.origin}`}>{ORIGIN_LABEL[found.origin]}</span>
              </button>
            ))
          )}
        </div>
      )}

      {files === undefined || bash ? null : (
        <div className="filepop" role="listbox" aria-label="Files in this workspace">
          <div className="pophead">
            Files in {workspaceName ?? 'this workspace'} — type to filter, ⏎ inserts the path
          </div>
          {shown.length === 0 ? (
            <div className="popempty">No files match</div>
          ) : (
            shown.map((path, index) => {
              const cut = path.lastIndexOf('/')
              return (
                <button
                  key={path}
                  className={`popitem${index === selected ? ' sel' : ''}`}
                  role="option"
                  aria-selected={index === selected}
                  onMouseDown={(clicked) => clicked.preventDefault()}
                  onClick={() => insertPath(path)}
                >
                  <span className="file">{cut === -1 ? path : path.slice(cut + 1)}</span>
                  <span className="dir">{cut === -1 ? '' : path.slice(0, cut)}</span>
                </button>
              )
            })
          )}
        </div>
      )}

      {attachments.length === 0 ? null : (
        <div className="chips" aria-label="Attached images">
          {attachments.map((attachment) => (
            <span className="imgchip" key={attachment.id}>
              <img
                src={`data:${attachment.mimeType};base64,${attachment.data}`}
                alt={attachment.name}
              />
              <button
                className="x"
                aria-label={`Remove ${attachment.name}`}
                onClick={() => onRemoveAttachment(attachment.id)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className={`cbox${bash ? ' bash' : ''}${commandMode ? ' cmd' : ''}`}>
        {bash ? (
          <div className="modebadge">
            bash <span className="cwd">· {sessionDirectory ?? ''}</span>
          </div>
        ) : commandMode ? (
          <div className="modebadge command">command</div>
        ) : null}
        <div className="boxwrap">
          <textarea
            aria-label="Message"
            placeholder={
              disabled
                ? 'No session'
                : 'Message the agent — / for commands, @ a file, ! runs bash, ⌘V pastes an image'
            }
            value={draft}
            disabled={disabled}
            onChange={(changed) => {
              onDraft(changed.target.value)
              look(changed.target)
            }}
            onClick={(clicked) => look(clicked.currentTarget)}
            onKeyUp={(pressed) => {
              // Arrow keys move the caret out of a token without changing the
              // text, so the popover follows the caret and not only the typing.
              if (pressed.key.startsWith('Arrow')) look(pressed.currentTarget)
            }}
            ref={holdBox}
            onKeyDown={(pressed) => {
              // The command popover owns Enter while it is open, exactly as the
              // file popover does: nothing can send from under it.
              if (matches !== undefined) {
                if (matches.length === 0) {
                  if (pressed.key === 'Enter' && !pressed.shiftKey) {
                    pressed.preventDefault()
                    return
                  }
                } else {
                  if (pressed.key === 'ArrowDown' || pressed.key === 'ArrowUp') {
                    pressed.preventDefault()
                    const by = pressed.key === 'ArrowDown' ? 1 : matches.length - 1
                    selectCommand((commandSelected + by) % matches.length)
                    return
                  }
                  // Plain Tab keeps its popover meaning; Shift-Tab belongs to
                  // the document above and never inserts anything here.
                  if (pressed.key === 'Enter' || (pressed.key === 'Tab' && !pressed.shiftKey)) {
                    pressed.preventDefault()
                    const found = matches[commandSelected]
                    if (found !== undefined) insertCommand(found.name)
                    return
                  }
                }
              }
              // While the popover is open Enter belongs to it, so nothing here
              // can send a draft nobody can unsend.
              if (filesOpen) {
                if (shown.length === 0) {
                  if (pressed.key === 'Enter' && !pressed.shiftKey) {
                    pressed.preventDefault()
                    onFileToken(undefined)
                    return
                  }
                } else {
                  if (pressed.key === 'ArrowDown' || pressed.key === 'ArrowUp') {
                    pressed.preventDefault()
                    const by = pressed.key === 'ArrowDown' ? 1 : shown.length - 1
                    select((selected + by) % shown.length)
                    return
                  }
                  if (pressed.key === 'Enter' || (pressed.key === 'Tab' && !pressed.shiftKey)) {
                    pressed.preventDefault()
                    const path = shown[selected]
                    if (path !== undefined) insertPath(path)
                    return
                  }
                }
              }
              if (pressed.key === 'ArrowUp' && pressed.altKey) {
                pressed.preventDefault()
                onRestoreLast()
                return
              }
              if (pressed.key !== 'Enter' || pressed.shiftKey) return
              pressed.preventDefault()
              if (bash) {
                run()
                return
              }
              if (!sendable) return
              // Never a dead key: idle, Option+Enter is a plain send.
              if (pressed.altKey) onFollowUp()
              else onSend()
            }}
          />
          {/* The measuring twin: same width, same typography, never seen and
              never read out. The trailing zero-width space keeps a draft that
              ends in a newline one line taller, exactly as the text area is. */}
          <div className="boxmirror" aria-hidden="true" ref={mirror}>
            {draft}
            {'\u200b'}
          </div>
        </div>
        <div className="crow">
          <div className="chipwrap">
            <button
              className="chip"
              aria-label={`Model: ${chipName ?? 'none'}`}
              aria-expanded={modelPickerOpen}
              // Between turns only. The model ring bypasses this button, so a
              // keystroke may still switch mid-turn.
              disabled={disabled || working}
              onClick={onToggleModelPicker}
            >
              <span aria-hidden="true">⌾</span> <b>{chipName ?? 'no model'}</b>
            </button>
            {modelPickerOpen ? (
              <ModelPicker models={models} current={modelId} onSelect={onSelectModel} />
            ) : null}
          </div>

          <div className="chipwrap">
            <button
              className="chip"
              aria-label={`Thinking: ${thinkingLevel ?? 'none'}`}
              aria-expanded={thinkingMenuOpen}
              disabled={disabled || working || (model?.thinkingLevels.length ?? 0) === 0}
              onClick={onToggleThinkingMenu}
            >
              <span aria-hidden="true">✦</span> think: <b>{thinkingLevel ?? '—'}</b>
            </button>
            {thinkingMenuOpen ? (
              <div className="pop menu" role="menu" aria-label="Thinking levels">
                {(model?.thinkingLevels ?? []).map((level) => (
                  <button
                    key={level}
                    role="menuitem"
                    aria-current={level === thinkingLevel ? 'true' : undefined}
                    onClick={() => onSelectThinkingLevel(level)}
                  >
                    {level}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {/* Absent entirely outside a git workspace, which is the whole of
              what a non-git workspace sees of this. */}
          {worktreeShown ? (
            <button
              className={`chip wt${worktree === undefined ? '' : ' on branch'}${
                worktreeBusy ? ' busy' : ''
              }`}
              aria-label={worktreeChipLabel(worktree, worktreeBusy)}
              // Working, and still where it was: a flip back keeps saying
              // which worktree until the rebind behind it lands.
              aria-busy={worktreeBusy}
              // Locked and busy are both merely non-interactable: the chip's
              // own rendering is the whole of the signal.
              disabled={disabled || worktreeBusy || worktreeLocked}
              onClick={onToggleWorktree}
            >
              {worktreeBusy && worktree === undefined ? (
                <>
                  <span className="g" aria-hidden="true">
                    ⑂
                  </span>
                  creating worktree…
                </>
              ) : worktree === undefined ? (
                <>
                  <span className="g" aria-hidden="true">
                    ◇
                  </span>
                  checkout
                </>
              ) : (
                <>
                  <span className="g" aria-hidden="true">
                    ⑂
                  </span>
                  <b>{worktreeLabel(worktree)}</b>
                </>
              )}
            </button>
          ) : null}

          {/* One slot, one footprint: Send while idle becomes Stop while
              working, so nothing around it moves. Enter still steers. */}
          {bash ? (
            <button className="send" disabled={!runnable} onClick={run}>
              Run ⏎
            </button>
          ) : working ? (
            <button className="stop" onClick={onStop}>
              <span className="spin" aria-hidden="true" />
              <span className="stopsq" aria-hidden="true" />
              Stop
            </button>
          ) : (
            <button className="send" disabled={!sendable} onClick={onSend}>
              Send
            </button>
          )}
        </div>

        {/* What the script or git printed, verbatim: the session is already
            back on the checkout by the time this is read. */}
        {worktreeOutput === undefined ? null : (
          <pre className="wtout" role="alert">
            {worktreeOutput}
          </pre>
        )}
      </div>

      {/* Height is reserved in every state, idle included, so nothing above
          or below moves when live state lands here. */}
      <div className="esc">
        {bash ? (
          <span className="bashnote">
            runs locally in the workspace — nothing goes to the model
          </span>
        ) : working ? (
          <>
            <span className="workingnote">
              agent working{elapsedSeconds === undefined ? '' : ` · ${elapsedSeconds}s`}
            </span>{' '}
            — <kbd>⏎</kbd> steer · <kbd>⌥⏎</kbd> follow-up · <kbd>esc</kbd> stop
          </>
        ) : null}
      </div>
    </div>
  )
}

// The port's own labels and order, never an alias, so an unfamiliar model
// stays identifiable. Its query state is its own, so reopening starts clean.
function ModelPicker({
  models,
  current,
  onSelect
}: {
  readonly models: readonly ModelInfo[]
  readonly current?: string
  readonly onSelect: (id: string) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const wanted = query.trim().toLowerCase()
  const shown = models.filter(
    (model) =>
      wanted === '' ||
      model.label.toLowerCase().includes(wanted) ||
      model.id.toLowerCase().includes(wanted)
  )

  return (
    <div className="pop picker" role="dialog" aria-label="Model picker">
      <input
        className="search"
        aria-label="Search models"
        placeholder="Search models…"
        autoFocus
        value={query}
        onChange={(changed) => setQuery(changed.target.value)}
        onKeyDown={(pressed) => {
          if (pressed.key !== 'Enter') return
          pressed.preventDefault()
          const first = shown[0]
          if (first !== undefined) onSelect(first.id)
        }}
      />
      <ul className="models">
        {shown.map((model) => (
          <li key={model.id}>
            <button
              aria-current={model.id === current ? 'true' : undefined}
              onClick={() => onSelect(model.id)}
            >
              <span className="mname">{model.label}</span>
              {model.id === current ? (
                <span className="check" aria-hidden="true">
                  ✓
                </span>
              ) : null}
            </button>
          </li>
        ))}
        {shown.length === 0 ? <li className="nomodels">No model matches that.</li> : null}
      </ul>
    </div>
  )
}

// Ticks once a second from the moment this document saw the turn start, so the
// number shown is measured rather than reported.
export function useElapsedSeconds(since: number | undefined): number | undefined {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (since === undefined) return
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [since])

  if (since === undefined) return undefined
  // A turn that has just started reads zero until the first tick, which is
  // what a second-resolution clock can honestly say about it.
  return Math.max(0, Math.floor((now - since) / 1000))
}
