import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import {
  IMAGE_LIMITS,
  readToolWithShrunkImages,
  shrinkAttachments,
  shrinkImage,
  type ImageContent,
  type Shrink,
  type ShrunkImage
} from './shrink-images'

// Base64 of the given byte length, so a size sits on the right side of the
// budget without a real picture.
const base64Of = (length: number): string => 'A'.repeat(length)

const big: ImageContent = {
  type: 'image',
  data: base64Of(IMAGE_LIMITS.maxBytes + 1),
  mimeType: 'image/png'
}
const small: ImageContent = { type: 'image', data: base64Of(100), mimeType: 'image/png' }

const shrunk = (over: Partial<ShrunkImage> = {}): ShrunkImage => ({
  data: base64Of(1000),
  mimeType: 'image/jpeg',
  originalWidth: 1040,
  originalHeight: 1360,
  width: 1040,
  height: 1360,
  wasResized: true,
  ...over
})

function shrinker(answer: ShrunkImage | null): Shrink & { calls: [string, typeof IMAGE_LIMITS][] } {
  const calls: [string, typeof IMAGE_LIMITS][] = []
  const shrink: Shrink = async (_bytes, mimeType, limits) => {
    calls.push([mimeType, limits])
    return answer
  }
  return Object.assign(shrink, { calls })
}

describe('shrinking one image', () => {
  it('leaves an image under the budget alone, without asking', async () => {
    const shrink = shrinker(shrunk())
    expect(await shrinkImage(small, shrink)).toEqual({ image: small })
    expect(shrink.calls).toEqual([])
  })

  it('shrinks an image over the budget with the budget', async () => {
    const shrink = shrinker(shrunk())
    const result = await shrinkImage(big, shrink)
    expect(result.image).toEqual({ type: 'image', data: base64Of(1000), mimeType: 'image/jpeg' })
    expect(shrink.calls).toEqual([['image/png', IMAGE_LIMITS]])
  })

  it('notes a re-encode, and coordinates only when they moved', async () => {
    const same = await shrinkImage(big, shrinker(shrunk()))
    expect(same.note).toBe('[Image shrunk to fit the request: 1040x1360, image/jpeg.]')

    const scaled = await shrinkImage(big, shrinker(shrunk({ width: 520, height: 680 })))
    expect(scaled.note).toBe(
      '[Image shrunk to fit the request: 1040x1360 shown at 520x680; ' +
        'multiply coordinates by 2.00 to reach the original, image/jpeg.]'
    )
  })

  it('keeps the original when shrinking fails or gains nothing', async () => {
    expect(await shrinkImage(big, shrinker(null))).toEqual({ image: big })
    expect(await shrinkImage(big, shrinker(shrunk({ data: big.data })))).toEqual({ image: big })
    const throwing: Shrink = async () => {
      throw new Error('no photon')
    }
    expect(await shrinkImage(big, throwing)).toEqual({ image: big })
  })
})

describe('shrinking what a person attached', () => {
  it('keeps nothing as nothing', async () => {
    expect(await shrinkAttachments(undefined, shrinker(shrunk()))).toBeUndefined()
    expect(await shrinkAttachments([], shrinker(shrunk()))).toBeUndefined()
  })

  it('shrinks each over the budget and keeps the rest, in order', async () => {
    const attached = [
      { data: big.data, mimeType: 'image/png' },
      { data: small.data, mimeType: 'image/webp' }
    ]
    expect(await shrinkAttachments(attached, shrinker(shrunk()))).toEqual([
      { type: 'image', data: base64Of(1000), mimeType: 'image/jpeg' },
      { type: 'image', data: small.data, mimeType: 'image/webp' }
    ])
  })
})

describe('the read tool with shrunk images', () => {
  const base = (content: unknown[]): ToolDefinition =>
    ({
      name: 'read',
      label: 'Read',
      description: 'reads',
      parameters: { type: 'object' },
      async execute() {
        return { content, details: { truncation: undefined } }
      }
    }) as unknown as ToolDefinition

  const call = (tool: ToolDefinition): Promise<{ content: unknown[]; details: unknown }> =>
    tool.execute('c1', {} as never, undefined, undefined, undefined as never) as never

  it('keeps the name, so it stands in for the builtin', () => {
    const tool = readToolWithShrunkImages(base([]), shrinker(null))
    expect(tool.name).toBe('read')
    expect(tool.description).toBe('reads')
  })

  it('passes text results through untouched', async () => {
    const tool = readToolWithShrunkImages(base([{ type: 'text', text: 'hello' }]), shrinker(null))
    expect(await call(tool)).toEqual({
      content: [{ type: 'text', text: 'hello' }],
      details: { truncation: undefined }
    })
  })

  it('shrinks the image and says so on the leading text block', async () => {
    const tool = readToolWithShrunkImages(
      base([{ type: 'text', text: 'Read image file [image/png]' }, big]),
      shrinker(shrunk())
    )
    expect((await call(tool)).content).toEqual([
      {
        type: 'text',
        text:
          'Read image file [image/png]\n' +
          '[Image shrunk to fit the request: 1040x1360, image/jpeg.]'
      },
      { type: 'image', data: base64Of(1000), mimeType: 'image/jpeg' }
    ])
  })

  it('leaves a small image and its note alone', async () => {
    const content = [{ type: 'text', text: 'Read image file [image/png]' }, small]
    const tool = readToolWithShrunkImages(base(content), shrinker(shrunk()))
    expect((await call(tool)).content).toEqual(content)
  })
})
