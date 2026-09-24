import { didLabel, type FiringView } from '../../../shared/rules/board'
import { relativeTime } from '../labels'
import { agentText, cameText, deliveredText, didTone, snippetText, spotText } from './format'

// One firing as a row: the board's firing list and the run view's rules tab
// both draw it, the tab without the "in" column because every row there is
// that node.

export function FiringColumns({ node = false }: { readonly node?: boolean }): React.JSX.Element {
  return (
    <div className={`fcolhead${node ? ' node' : ''}`} aria-hidden="true">
      <span>did</span>
      <span>where</span>
      {node ? null : <span>in</span>}
      <span>came of it</span>
      <span>delivered</span>
      <span>when</span>
    </div>
  )
}

export function FiringRow({
  view,
  now,
  focused = false,
  node = false,
  sessionTitle,
  onClick
}: {
  readonly view: FiringView
  readonly now: number
  readonly focused?: boolean
  /** Drawn inside one node: no "in" column. */
  readonly node?: boolean
  readonly sessionTitle: (sessionId: string) => string | undefined
  readonly onClick: () => void
}): React.JSX.Element {
  const { firing } = view
  const snippet = snippetText(firing)
  const came = cameText(view)
  const who = agentText(firing.agent, sessionTitle)
  return (
    <button
      type="button"
      className={`frow${node ? ' node' : ''}${focused ? ' focused' : ''}`}
      aria-label={`${firing.rule} ${didLabel(firing)} at ${spotText(firing)}`}
      aria-current={focused ? 'true' : undefined}
      onClick={onClick}
    >
      <span className={`fact ${didTone(firing)}`}>{didLabel(firing)}</span>
      <span className="fwhere">
        {spotText(firing)}
        {snippet === undefined ? null : <span className="snip"> — {snippet}</span>}
      </span>
      {node ? null : (
        <span className="fwho">
          {who.run === undefined ? null : (
            <>
              <span className="t">{who.run}</span> ·{' '}
            </>
          )}
          {who.text}
        </span>
      )}
      <span className={`fout ${came.tone}`}>{came.text}</span>
      <span className="fdeliv">{deliveredText(firing)}</span>
      <span className="fage">{relativeTime(firing.at, now)}</span>
    </button>
  )
}
