// @vitest-environment node
//
// π's queue is text, so this is the bookkeeping that keeps a queued message's
// pictures with it. No SDK and no session: the pairing is all there is to it.
import { describe, expect, it } from 'vitest'
import type { ImageAttachment } from '../../shared/agent/port'
import { createQueuedImages, withImages } from './queued-images'

const SHOT: ImageAttachment = { mimeType: 'image/png', data: 'AAAAAA==' }
const OTHER: ImageAttachment = { mimeType: 'image/jpeg', data: 'BBBBBB==' }

describe('pairing π’s queue back up', () => {
  it('carries no image list at all for a message that had none', () => {
    const queued = createQueuedImages()
    queued.add('steering', 'plain words')

    expect(queued.pair(['plain words'], [])).toEqual({
      steering: [{ text: 'plain words' }],
      followUp: [],
      left: []
    })
  })

  it('keeps each kind’s pictures on its own messages, in π’s order', () => {
    const queued = createQueuedImages()
    queued.add('steering', 'look at this', [SHOT])
    queued.add('followUp', 'and this after', [OTHER])

    expect(queued.pair(['look at this'], ['and this after'])).toEqual({
      steering: [{ text: 'look at this', images: [SHOT] }],
      followUp: [{ text: 'and this after', images: [OTHER] }],
      left: []
    })
  })

  // Two queued messages can hold the same words with different pictures, so
  // position decides which is which.
  it('keeps two look-alike messages in π’s order', () => {
    const queued = createQueuedImages()
    queued.add('steering', 'again', [SHOT])
    queued.add('steering', 'again', [OTHER])

    expect(queued.pair(['again', 'again'], []).steering).toEqual([
      { text: 'again', images: [SHOT] },
      { text: 'again', images: [OTHER] }
    ])
  })

  // π's queue is FIFO and the list it reports loses its first occurrence of the
  // delivered text, so a run of look-alikes that shrinks lost its oldest. The
  // row still queued is the younger one, holding its own picture.
  it('leaves the younger of two look-alikes queued when one is delivered', () => {
    const queued = createQueuedImages()
    queued.add('steering', 'again', [SHOT])
    queued.add('steering', 'again', [OTHER])
    queued.pair(['again', 'again'], [])

    expect(queued.pair(['again'], [])).toEqual({
      steering: [{ text: 'again', images: [OTHER] }],
      followUp: [],
      left: [{ text: 'again', images: [SHOT] }]
    })
  })

  it('forgets what π no longer lists, because it has left the queue', () => {
    const queued = createQueuedImages()
    queued.add('steering', 'delivered', [SHOT])
    queued.add('steering', 'still waiting', [OTHER])

    expect(queued.pair(['still waiting'], []).left).toEqual([
      { text: 'delivered', images: [SHOT] }
    ])
    expect(queued.take()).toEqual({
      steering: [{ text: 'still waiting', images: [OTHER] }],
      followUp: []
    })
  })

  it('empties on a take, so the clear that follows it finds nothing', () => {
    const queued = createQueuedImages()
    queued.add('steering', 'look at this', [SHOT])

    expect(queued.take().steering).toEqual([{ text: 'look at this', images: [SHOT] }])
    expect(queued.take()).toEqual({ steering: [], followUp: [] })
  })
})

// Removing one queued message costs π's queue a clear and a requeue, which is
// where the others would lose their pictures.
describe('what a dequeue leaves the others holding', () => {
  it('is their own images, in the order π puts them back', () => {
    const held = [
      { text: 'the first', images: [SHOT] },
      { text: 'the second', images: [OTHER] },
      { text: 'the third' }
    ]

    expect(withImages(['the second', 'the third'], held)).toEqual([
      { text: 'the second', images: [OTHER] },
      { text: 'the third' }
    ])
  })

  it('is nothing at all for a message this memory never saw', () => {
    expect(withImages(['queued elsewhere'], [])).toEqual([{ text: 'queued elsewhere' }])
  })

  // Nothing left the queue here, because π handed the whole of it back, so two
  // look-alikes keep the pictures they were queued with, in that order.
  it('is each look-alike’s own picture when the whole queue comes back', () => {
    const held = [
      { text: 'again', images: [SHOT] },
      { text: 'again', images: [OTHER] }
    ]

    expect(withImages(['again', 'again'], held)).toEqual(held)
  })
})
