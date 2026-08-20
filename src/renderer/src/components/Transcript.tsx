import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ViewItem } from '../state/shell-state'
import {
  callSummary,
  countsText,
  groupIntoChains,
  type LoneItem,
  type ToolChain,
  type ToolItem
} from '../state/tool-chains'
import { Markdown } from './Markdown'
import './transcript.css'

// Follows the stream only while the reader is already at the bottom: scrolling
// up stops the follow, and nothing pulls them back down.
export function Transcript({
  items,
  sessionId,
  invocations
}: {
  readonly items: readonly ViewItem[]
  /** Switching sessions starts the reader at the bottom of the new one again. */
  readonly sessionId: string
  // The port never learns commands exist, so this mapping lives in the
  // document and nowhere else.
  readonly invocations?: ReadonlyMap<string, string>
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

  // Content also grows between React renders, when a settled message swaps in
  // taller than its stream or a font arrives, so any resize re-pins.
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
        {groupIntoChains(items).map((row) => (
          // The session is part of the key, so what a reader opened in one
          // session can never be what another session shows opened.
          <li key={`${sessionId}:${row.key}`}>
            {row.kind === 'chain' ? (
              <Chain chain={row.chain} />
            ) : (
              <Item item={row.item} invocations={invocations} />
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}

function Item({
  item,
  invocations
}: {
  readonly item: LoneItem
  readonly invocations?: ReadonlyMap<string, string>
}): React.JSX.Element {
  switch (item.kind) {
    case 'user': {
      // A message this document expanded from a command reads as the
      // invocation, and opens to the delivered text byte for byte.
      const invocation = invocations?.get(item.text)
      if (invocation !== undefined) {
        return <CommandMessage invocation={invocation} delivered={item.text} />
      }
      return (
        <div className="msg user" aria-label="You">
          <div className="who">You</div>
          {/* Plain text, always: a person's own message is never markdown. */}
          <div className="bubble">{item.text}</div>
          {item.images === undefined || item.images.length === 0 ? null : (
            <div className="thumbs">
              {item.images.map((image, index) => (
                <img
                  key={`${image.mimeType}-${index}`}
                  className="thumb"
                  src={`data:${image.mimeType};base64,${image.data}`}
                  alt={`Attached image ${index + 1}`}
                />
              ))}
            </div>
          )}
        </div>
      )
    }

    // A run the user added to the conversation, in the tool row's own visual
    // grammar and marked for what it is: the model can see this one.
    case 'bashRun':
      return (
        <div className="bashrow" aria-label={`Shared bash run: ${item.command}`}>
          <div className={`bashhead ${item.exitCode === 0 ? 'ok' : 'failed'}`}>
            <span aria-hidden="true">$</span>
            <span className="cmd">{item.command}</span>
            <span className="sharetag">shared with model</span>
          </div>
          {item.output === '' ? null : <pre className="bashout">{item.output}</pre>}
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

    // The context the conversation now stands on — a branch summary or a
    // compaction — shown in full so nobody wonders what the agent knows.
    case 'summary':
      return (
        <div className="summarycard" aria-label="Context summary">
          <div className="sumtag">context summary</div>
          <Markdown markdown={item.text} />
        </div>
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

// Compact by default and honest underneath: the compact form is presentation,
// never a different record, so what opens is exactly what crossed the port.
function CommandMessage({
  invocation,
  delivered
}: {
  readonly invocation: string
  readonly delivered: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)

  return (
    <div className="msg user command" aria-label="You">
      <div className="who">You</div>
      <button
        className="bubble cmdbubble"
        aria-expanded={open}
        aria-label={`Command ${invocation}`}
        onClick={() => setOpen(!open)}
      >
        <span className="disc" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="cmdtext">{invocation}</span>
        <span className="cmdsaid">{open ? 'delivered' : 'command'}</span>
      </button>
      {open ? <div className="bubble cmdfull">{delivered}</div> : null}
    </div>
  )
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

// Collapsed from the first call and never collapsing on its own afterwards, so
// a chain that finishes does not move the transcript under the reader.
function Chain({ chain }: { readonly chain: ToolChain }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const counts = countsText(chain.counts)

  return (
    <div className={`chain ${chain.state}${open ? ' open' : ''}`}>
      <button
        className="chainhead"
        aria-expanded={open}
        aria-label={['Tool chain', counts, chain.label].filter((part) => part !== '').join(' · ')}
        onClick={() => setOpen(!open)}
      >
        {chain.live === undefined ? (
          <span className="disc" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
        ) : (
          // Still spinning while work continues, even once a call has failed.
          <span className="spin" aria-hidden="true" />
        )}
        <span className="counts">
          {chain.counts.map((count, index) => (
            <span key={count.name}>
              {index === 0 ? '' : ' · '}
              {/* The number is keyed by its own value, so a count that goes up
                  is a new element and its pulse plays again. */}
              <span
                key={count.count}
                className={`n${chain.live === undefined ? '' : ' tick'}`}
              >
                {count.count}
              </span>{' '}
              {count.name}
            </span>
          ))}
        </span>
        {/* Whatever is running right now, and nothing once the chain settles. */}
        <span className="live">
          {chain.live === undefined ? '' : `${chain.live.name} ${callSummary(chain.live)}`}
        </span>
        <span className="chainstate">{chain.label}</span>
      </button>
      {open ? (
        <div className="calls">
          {chain.calls.map((call, index) => (
            <Call key={call.callId ?? `call-${index}`} call={call} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function Call({ call }: { readonly call: ToolItem }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const tail = useRef<HTMLPreElement>(null)
  const { name, output, ok, running } = call
  // Before the call runs this is its argument count; afterwards it is the
  // one-line summary, in the same slot and on the same element.
  const summary = callSummary(call)

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
