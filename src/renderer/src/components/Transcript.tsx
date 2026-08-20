import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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
  const content = useRef<HTMLOListElement>(null)
  const following = useRef(true)

  function pin(): void {
    const node = scroller.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }

  // Layout effects pin before paint, so a grown transcript is never shown
  // unpinned for a frame first.
  useLayoutEffect(() => {
    following.current = true
    pin()
  }, [sessionId])

  useLayoutEffect(() => {
    if (following.current) pin()
  })

  // Effects only see React renders. Content can also grow between them — a
  // settled message swapping in taller than its stream, a font arriving — so
  // while following, any resize of the content or the viewport re-pins.
  // jsdom has no ResizeObserver; the render-time pins above still cover tests.
  const empty = items.length === 0
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (following.current) pin()
    })
    if (scroller.current !== null) observer.observe(scroller.current)
    if (content.current !== null) observer.observe(content.current)
    return () => observer.disconnect()
  }, [sessionId, empty])

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
      <ol className="items" ref={content}>
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
      return <Thinking text={item.text} running={item.running} />

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

// A single dim element, no heading and no collapse: the header row stacked on
// the visible trace bought nothing, and folding it caused layout shift.
function Thinking({
  text,
  running
}: {
  readonly text: string
  readonly running: boolean
}): React.JSX.Element {
  return (
    <div className={`think${running ? ' running' : ''}`}>
      <div className="thinkbody">{text}</div>
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
