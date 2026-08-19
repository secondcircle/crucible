import { useEffect, useRef, useState } from 'react'
import type { ViewItem } from '../state/shell-state'
import { Markdown } from './Markdown'
import './transcript.css'

// Follows the stream only while the reader is already at the bottom: scrolling
// up stops the follow, and nothing pulls them back down.
export function Transcript({
  items,
  sessionId
}: {
  readonly items: readonly ViewItem[]
  /** Switching sessions starts the reader at the bottom of the new one again. */
  readonly sessionId: string
}): React.JSX.Element {
  const scroller = useRef<HTMLDivElement>(null)
  const following = useRef(true)

  useEffect(() => {
    following.current = true
    const node = scroller.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [sessionId])

  useEffect(() => {
    const node = scroller.current
    if (node === null || !following.current) return
    node.scrollTop = node.scrollHeight
  })

  function onScroll(): void {
    const node = scroller.current
    if (node === null) return
    // A reader within a line or two of the end still counts as at the end, so
    // a delta landing mid-scroll does not strand them.
    following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40
  }

  if (items.length === 0) {
    return (
      <div className="chat empty" ref={scroller} onScroll={onScroll}>
        <p className="emptynote">This session is empty.</p>
      </div>
    )
  }

  return (
    <div className="chat" ref={scroller} onScroll={onScroll} role="log" aria-label="Transcript">
      <ol className="items">
        {items.map((item, index) => (
          // The transcript is append-only and never reordered, so position is
          // a stable key, and unlike an id it cannot be minted by a port.
          <li key={index}>
            <Item item={item} />
          </li>
        ))}
      </ol>
    </div>
  )
}

function Item({ item }: { readonly item: ViewItem }): React.JSX.Element {
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg user" aria-label="You">
          <div className="who">You</div>
          {/* Plain text, always: a person's own message is never markdown. */}
          <div className="bubble">{item.text}</div>
        </div>
      )

    case 'assistant':
      return (
        <div className="msg agent" aria-label="Agent">
          <div className="who">Agent</div>
          <Markdown markdown={item.markdown} />
          {item.streaming ? <span className="cursor" aria-hidden="true" /> : null}
        </div>
      )

    case 'thinking':
      return <Thinking text={item.text} seconds={item.seconds} running={item.running} />

    case 'tool':
      return (
        <Tool
          name={item.name}
          summary={item.summary}
          output={item.output}
          ok={item.ok}
          running={item.running}
        />
      )

    case 'stopped':
      return <div className="stopped">Stopped</div>

    case 'error':
      return (
        <div className="errcard" role="alert">
          <b>Turn failed</b> — {item.message}
        </div>
      )
  }
}

function Thinking({
  text,
  seconds,
  running
}: {
  readonly text: string
  readonly seconds?: number
  readonly running: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const heading = running
    ? 'thinking…'
    : seconds === undefined
      ? 'thought'
      : `thought for ${seconds}s`

  return (
    <div className={`think${running ? ' running' : ''}`}>
      <button className="thinkhead" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> {heading}
      </button>
      {open || running ? <div className="thinkbody">{text}</div> : null}
    </div>
  )
}

// Every tool renders the same way; per-tool renderings are later work.
function Tool({
  name,
  summary,
  output,
  ok,
  running
}: {
  readonly name: string
  readonly summary: string
  readonly output: string
  readonly ok?: boolean
  readonly running: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const tail = useRef<HTMLPreElement>(null)

  useEffect(() => {
    // While a tool runs its output tails rather than grows, so a long-running
    // call cannot push the rest of the transcript off the screen.
    const node = tail.current
    if (node !== null && running) node.scrollTop = node.scrollHeight
  }, [output, running])

  // A call cut off by a cancelled turn never said how it went, and this is not
  // the place to decide for it.
  const state = running ? 'running' : ok === undefined ? 'stopped' : ok ? 'ok' : 'failed'
  const said = running ? 'running' : ok === undefined ? 'stopped' : ok ? 'done' : 'error'

  return (
    <div className={`tool ${state}`}>
      <button
        className="toolhead"
        aria-expanded={running ? undefined : open}
        aria-label={`${name} ${summary}`.trim()}
        onClick={() => setOpen(!open)}
      >
        {running ? (
          <span className="spin" aria-hidden="true" />
        ) : (
          <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        )}
        <span className="toolname">{name}</span>
        <span className="toolsummary">{summary}</span>
        <span className="toolstate">{said}</span>
      </button>
      {(running || open) && output !== '' ? (
        <pre className="toolout" ref={tail}>
          {output}
        </pre>
      ) : null}
    </div>
  )
}
