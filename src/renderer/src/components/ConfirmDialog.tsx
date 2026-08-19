import './overlay.css'

/**
 * The guard dialog: two buttons, one sentence, no numbers it cannot honestly
 * compute (MO-7, SE-7).
 *
 * It is the only modal in the shell and the only cache-related surface in this
 * work. It says what the action does and offers the way out first, in the Ember
 * pattern from the details mock — plain words, then actions.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel
}: {
  readonly title: string
  readonly body: string
  readonly confirmLabel: string
  readonly cancelLabel: string
  readonly onConfirm: () => void
  readonly onCancel: () => void
}): React.JSX.Element {
  return (
    <div className="overlaybg" onMouseDown={onCancel}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(clicked) => clicked.stopPropagation()}
      >
        <div className="dh">{title}</div>
        <div className="dbody">{body}</div>
        <div className="dfoot">
          <button className="btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className="btn primary" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
