import { useEffect, useState } from 'react'
import type { ModelInfo, ThinkingLevel } from '../../../shared/agent/port'
import './composer.css'

/**
 * The composer: the textarea, the two chips that own the session's model and
 * thinking level, and the one button that is Send or Stop.
 *
 * The keyboard rules are here because this is where they are felt: Enter sends,
 * Shift+Enter makes a newline (CO-1), an empty or whitespace-only draft keeps
 * Send unavailable (CO-2), and while the session works the button becomes Stop,
 * Enter stops sending, and the textarea stays editable so the next instruction
 * can be drafted while the current one is being stopped (CO-3).
 *
 * Escape is not handled here. It has an app-wide precedence — close what is
 * open, else stop the work, else nothing (CO-4) — and precedence cannot live in
 * the component that only knows about one of the three.
 *
 * No attachment control and no agent byline: both are deliberate omissions
 * (A2, CO-6).
 */
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
  onDraft,
  onSend,
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
  /** Genuine elapsed working time, measured from the observed turn start. */
  readonly elapsedSeconds?: number
  readonly model?: ModelInfo
  readonly modelId?: string
  readonly models: readonly ModelInfo[]
  readonly modelPickerOpen: boolean
  readonly thinkingLevel?: ThinkingLevel
  readonly thinkingMenuOpen: boolean
  readonly onDraft: (draft: string) => void
  readonly onSend: () => void
  readonly onStop: () => void
  readonly onToggleModelPicker: () => void
  readonly onSelectModel: (id: string) => void
  readonly onToggleThinkingMenu: () => void
  readonly onSelectThinkingLevel: (level: ThinkingLevel) => void
}): React.JSX.Element {
  const sendable = !disabled && !working && draft.trim() !== ''

  return (
    <div className="composer">
      <div className="cbox">
        <textarea
          aria-label="Message"
          placeholder={disabled ? 'No session' : 'Message the agent…'}
          value={draft}
          disabled={disabled}
          onChange={(changed) => onDraft(changed.target.value)}
          onKeyDown={(pressed) => {
            if (pressed.key !== 'Enter' || pressed.shiftKey) return
            pressed.preventDefault()
            if (sendable) onSend()
          }}
        />
        <div className="crow">
          <div className="chipwrap">
            <button
              className="chip"
              aria-label={`Model: ${model?.label ?? modelId ?? 'none'}`}
              aria-expanded={modelPickerOpen}
              // Model and thinking level belong to the session and change
              // between turns, never during one (MO-6).
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
            <button className="send working" onClick={onStop}>
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
      </div>

      <div className="esc">
        {working ? (
          <>
            <span className="workingnote">
              agent working{elapsedSeconds === undefined ? '' : ` · ${elapsedSeconds}s`}
            </span>{' '}
            — <kbd>esc</kbd> or Stop to cancel ·{' '}
          </>
        ) : null}
        <kbd>⇧⏎</kbd> newline
      </div>
    </div>
  )
}

/**
 * The searchable model picker (MO-1, mock D's interaction in Ember's clothes).
 * It lists what the port reported and nothing else — no model is named in
 * Crucible's own source (MO-2) — and its query state is its own, so opening it
 * again starts clean.
 */
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

/**
 * Genuine elapsed working time, ticking once a second from the moment this
 * document saw the turn start (TR-6). It is a hook rather than a component so
 * the composer can render the number inline.
 */
export function useElapsedSeconds(since: number | undefined): number | undefined {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (since === undefined) return
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [since])

  if (since === undefined) return undefined
  // A turn that has just started reads zero until the first tick, which is what
  // a second-resolution clock can honestly say about it.
  return Math.max(0, Math.floor((now - since) / 1000))
}
