import './overlay.css'

// The way out is offered first, because the actions guarded by this dialog are
// the ones that cost a conversation or cost money.
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
