// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { markTurnContext, stripTurnContext } from './turn-context'

describe('turn-start context in a stored message', () => {
  it('puts the context before the message and takes it back out whole', () => {
    const marked = markTurnContext('run 45c8 — interrupted · app quit', 'how is it going?')

    // The model reads both, in that order.
    expect(marked.indexOf('interrupted')).toBeLessThan(marked.indexOf('how is it going?'))
    // A person reads what they typed and nothing else.
    expect(stripTurnContext(marked)).toBe('how is it going?')
  })

  it('leaves an ordinary message exactly as it was', () => {
    expect(stripTurnContext('just a message')).toBe('just a message')
    expect(stripTurnContext('')).toBe('')
  })

  it('hides its own tail rather than half a block when a block never closes', () => {
    const broken = `${markTurnContext('status', 'typed').split('</')[0]}`
    expect(stripTurnContext(broken)).toBe('')
  })

  it('strips every block, wherever a message carries them', () => {
    const twice = `${markTurnContext('first', 'typed')}\n${markTurnContext('second', 'again')}`
    expect(stripTurnContext(twice)).toBe('typed\n\n\nagain')
  })
})
