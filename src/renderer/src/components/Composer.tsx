import { useEffect, useState } from 'react'
import type { ModelInfo, ThinkingLevel } from '../../../shared/agent/port'
import './composer.css'

// The textarea stays editable while the session works so the next instruction
// can be drafted during a stop. Escape is deliberately not handled here: it
// has an app-wide precedence this component cannot see.
//
// The missing attachment control and agent byline are omissions, not oversights.
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
  boxRef,
  onDraft,
  onSend,
  onFollowUp,
  onRestoreLast,
  onStop,
  onToggleModelPicker,
  onSelectModel,
  onToggleThinkingMenu,
  onSelectThinkingLevel
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
}): React.JSX.Element {
  // While working the same draft queues instead of sending, so what makes a
  // draft usable is the same question in both states.
  const sendable = !disabled && draft.trim() !== ''

  return (
    <div className="composer">
      <div className="cbox">
        <textarea
          aria-label="Message"
          placeholder={disabled ? 'No session' : 'Message the agent…'}
          value={draft}
          disabled={disabled}
          onChange={(changed) => onDraft(changed.target.value)}
          ref={boxRef}
          onKeyDown={(pressed) => {
            if (pressed.key === 'ArrowUp' && pressed.altKey) {
              pressed.preventDefault()
              onRestoreLast()
              return
            }
            if (pressed.key !== 'Enter' || pressed.shiftKey) return
            pressed.preventDefault()
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

          {working ? (
            <>
              {/* Labelled for what it will do, because a hotkey is never the
                  only way to reach a capability. */}
              <button className="send steer" disabled={!sendable} onClick={onSend}>
                Steer ⏎
              </button>
              <button className="stop" onClick={onStop}>
                <span className="spin" aria-hidden="true" />
                <span className="stopsq" aria-hidden="true" />
                Stop
              </button>
            </>
          ) : (
            <button className="send" disabled={!sendable} onClick={onSend}>
              Send
            </button>
          )}
        </div>
      </div>

      <div className="esc">
        {working ? (
          <>
            <span className="workingnote">
              agent working{elapsedSeconds === undefined ? '' : ` · ${elapsedSeconds}s`}
            </span>{' '}
            — <kbd>⏎</kbd> steer · <kbd>⌥⏎</kbd> follow-up · <kbd>esc</kbd> stop ·{' '}
          </>
        ) : null}
        <kbd>⇧⏎</kbd> newline
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
