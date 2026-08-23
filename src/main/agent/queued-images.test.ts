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
      followUp: []
    })
  })

  it('keeps each kind’s pictures on its own messages, in π’s order', () => {
    const queued = createQueuedImages()
    queued.add('steering', 'look at this', [SHOT])
    queued.add('followUp', 'and this after', [OTHER])

    expect(queued.pair(['look at this'], ['and this after'])).toEqual({
      steering: [{ text: 'look at this', images: [SHOT] }],
      followUp: [{ text: 'and this after', images: [OTHER] }]
    })
  })

  // Two queued messages can hold the same words with different pictures, so
  // position decides which is which.
  it('claims the first unclaimed match when two messages read alike', () => {
    const queued = createQueuedImages()
    queued.add('steering', 'again', [SHOT])
    queued.add('steering', 'again', [OTHER])

    expect(queued.pair(['again', 'again'], []).steering).toEqual([
      { text: 'again', images: [SHOT] },
      { text: 'again', images: [OTHER] }
    ])
  })

  it('forgets what π no longer lists, because it has left the queue', () => {
    const queued = createQueuedImages()
    queued.add('steering', 'delivered', [SHOT])
    queued.add('steering', 'still waiting', [OTHER])

    queued.pair(['still waiting'], [])

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
})
