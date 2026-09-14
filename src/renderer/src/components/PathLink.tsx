import { useContext, type ReactNode } from 'react'
import { viewOf, type NamedPath } from '../files/named-path'
import { PathLinksContext, type ClickTarget } from '../files/path-links'
import './path-link.css'

// A file an agent named, as a control: one click shows it in the session's
// preview tab, a double-click keeps that tab. The same two gestures the file
// tree offers, so there is one behavior to learn.

function Target({
  target,
  look,
  title,
  children
}: {
  readonly target: ClickTarget
  /** How it reads: a code chip, a link, or a word in a tool chain row header. */
  readonly look: 'code' | 'link' | 'plain'
  readonly title: string
  readonly children: ReactNode
}): React.JSX.Element {
  const links = useContext(PathLinksContext)

  return (
    <button
      type="button"
      className={`pathlink ${look}`}
      title={title}
      // Nothing this sits in is a control: the tool chain row header's expand
      // is a button beside this one, not around it, so neither gesture here
      // has anything to be taken back from.
      onClick={() => links.open(target)}
      onDoubleClick={() => links.keep(target)}
    >
      {children}
    </button>
  )
}

export function PathButton({
  named,
  look,
  children
}: {
  readonly named: NamedPath
  readonly look: 'code' | 'link' | 'plain'
  readonly children: ReactNode
}): React.JSX.Element {
  return (
    <Target
      target={{ kind: 'file', path: named.path, view: viewOf(named) }}
      look={look}
      title={
        named.line === undefined
          ? `Open ${named.path}`
          : `Open ${named.path} at line ${named.line}`
      }
    >
      {children}
    </Target>
  )
}

/** A local address: the panel is where a page served here is looked at. */
export function AddressButton({
  address,
  children
}: {
  readonly address: string
  readonly children: ReactNode
}): React.JSX.Element {
  return (
    <Target
      target={{ kind: 'address', address }}
      look="link"
      title={`Open ${address} in the context panel`}
    >
      {children}
    </Target>
  )
}
