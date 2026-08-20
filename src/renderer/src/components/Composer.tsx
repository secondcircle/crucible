import { useEffect, useState } from 'react'
import type { ModelInfo, ThinkingLevel } from '../../../shared/agent/port'
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

/** At most this many rows render, exactly as the mock shows. */
const FILE_ROWS = 7

/** Any number of leading `!` is the same grammar, so `!!` never differs (Q25). */
function bashCommandOf(draft: string): string | undefined {
  if (!draft.startsWith('!')) return undefined
  return draft.replace(/^!+/, '').trim()
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
  workspaceName,
  workspacePath,
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
  onRunBash
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
  readonly workspaceName?: string
  readonly workspacePath?: string
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
}): React.JSX.Element {
  // The selection belongs to one result list: a fresh list is looked at from
  // the top rather than from wherever the last one had been left.
  const [selection, setSelection] = useState<{
    readonly of?: readonly string[]
    readonly at: number
  }>({ at: 0 })
  const command = bashCommandOf(draft)
  const bash = command !== undefined
  const shown = (files ?? []).slice(0, FILE_ROWS)
  const filesOpen = files !== undefined && !bash
  const selected = selection.of === files ? selection.at : 0

  function select(at: number): void {
    setSelection({ of: files, at })
  }

  // While the session works the same draft queues instead of sending, so what
  // makes a draft usable is the same question in both states. Steering and
  // follow-up carry text only in this cut, so chips hold them back.
  const heldBack = working && attachments.length > 0
  const sendable = !disabled && draft.trim() !== '' && !heldBack
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
  // read (Q9/Q20).
  function insertPath(path: string): void {
    const box = boxRef?.current ?? null
    const caret = box === null ? draft.length : (box.selectionStart ?? draft.length)
    const before = draft.slice(0, caret).replace(FILE_TOKEN, `@${path} `)
    onDraft(before + draft.slice(caret))
    onFileToken(undefined)
    box?.focus()
  }

  /** The mouse and dictation path to a grammar that is otherwise typed. */
  function insertAt(text: string): void {
    const box = boxRef?.current ?? null
    if (text === '!') {
      // Bash mode is a property of the whole line, so the bang goes in front
      // of it rather than wherever the caret happens to sit.
      onDraft(`!${draft}`)
      box?.focus()
      return
    }
    const caret = box === null ? draft.length : (box.selectionStart ?? draft.length)
    onDraft(`${draft.slice(0, caret)}${text}${draft.slice(caret)}`)
    onFileToken('')
    box?.focus()
  }

  function run(): void {
    if (!runnable || command === undefined) return
    onRunBash(command)
  }

  return (
    <div className="composer">
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

      <div className={`cbox${bash ? ' bash' : ''}`}>
        {bash ? (
          <div className="modebadge">
            bash <span className="cwd">· {workspacePath ?? ''}</span>
          </div>
        ) : null}
        <textarea
          aria-label="Message"
          placeholder={disabled ? 'No session' : 'Message the agent — @ a file, ! runs bash, ⌘V pastes an image'}
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
          ref={boxRef}
          onKeyDown={(pressed) => {
            if (filesOpen && shown.length > 0) {
              if (pressed.key === 'ArrowDown' || pressed.key === 'ArrowUp') {
                pressed.preventDefault()
                const by = pressed.key === 'ArrowDown' ? 1 : shown.length - 1
                select((selected + by) % shown.length)
                return
              }
              if (pressed.key === 'Enter' || pressed.key === 'Tab') {
                pressed.preventDefault()
                const path = shown[selected]
                if (path !== undefined) insertPath(path)
                return
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
        <div className="crow">
          <div className="chipwrap">
            <button
              className="chip"
              aria-label={`Model: ${model?.label ?? modelId ?? 'none'}`}
              aria-expanded={modelPickerOpen}
              // Model and thinking level change between turns, never during
              // one.
              disabled={disabled || working}
              onClick={onToggleModelPicker}
            >
              <span aria-hidden="true">⌾</span> <b>{model?.label ?? modelId ?? 'no model'}</b>
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

          {/* Typed grammar is an accelerator; these two are the mouse and
              dictation path to the same thing. */}
          <button
            className="chip grammar"
            aria-label="Mention a file"
            disabled={disabled || bash}
            onClick={() => insertAt('@')}
          >
            @ file
          </button>
          <button
            className="chip grammar"
            aria-label="Run a bash command"
            disabled={disabled || bash}
            onClick={() => insertAt('!')}
          >
            ! bash
          </button>

          {bash ? (
            <button className="send" disabled={!runnable} onClick={run}>
              Run ⏎
            </button>
          ) : working ? (
            /* Labelled for what it will do, because a hotkey is never the
               only way to reach a capability. */
            <button className="send steer" disabled={!sendable} onClick={onSend}>
              Steer ⏎
            </button>
          ) : (
            <button className="send" disabled={!sendable} onClick={onSend}>
              Send
            </button>
          )}

          {/* A bash run is the user's own work, never the agent's: running one
              mid-turn leaves the agent's Stop exactly where it was. */}
          {working ? (
            <button className="stop" onClick={onStop}>
              <span className="spin" aria-hidden="true" />
              <span className="stopsq" aria-hidden="true" />
              Stop
            </button>
          ) : null}
        </div>
      </div>

      <div className="esc">
        {bash ? (
          <span className="bashnote">
            runs locally in the workspace — nothing goes to the model
          </span>
        ) : heldBack ? (
          <span className="heldback">
            images go with the next prompt — stop the agent first to send them now
          </span>
        ) : working ? (
          <>
            <span className="workingnote">
              agent working{elapsedSeconds === undefined ? '' : ` · ${elapsedSeconds}s`}
            </span>{' '}
            — <kbd>⏎</kbd> steer · <kbd>⌥⏎</kbd> follow-up · <kbd>esc</kbd> stop ·{' '}
          </>
        ) : null}
        {bash ? null : (
          <>
            {' '}
            <kbd>⇧⏎</kbd> newline
          </>
        )}
      </div>
    </div>
  )
}

// Lists what the port reported and nothing else: no model is named in
// Crucible's own source. Its query state is its own, so reopening starts clean.
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
