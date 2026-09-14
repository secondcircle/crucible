import type { ToolDefinition } from '@earendil-works/pi-coding-agent'

// Every image in a conversation rides up again with every turn, and Anthropic
// refuses a request past 32 MB no matter how the bytes are spread. π's read
// tool only shrinks an image that is itself oversized (2000px, 4.5 MB), so a
// session that read seventy ordinary screenshots died at 93 MB with every
// single one of them "fine". Bytes are not tokens: compaction watches tokens,
// and seventy images were nowhere near the window. So the read tool's images
// are shrunk to a budget instead, small enough that the request limit is
// hundreds of reads away rather than dozens.
//
// Nothing already in the transcript is ever touched — rewriting history
// changes the cached prefix and every turn after would pay full price.

/** What one image may weigh when it enters the conversation. */
export const IMAGE_LIMITS = {
  // Anthropic downscales anything longer than 1568px on its own, so pixels
  // beyond that are bytes carried for nothing.
  maxWidth: 1568,
  maxHeight: 1568,
  // Base64 bytes. Sixty images at this ceiling fit one request; a typical
  // screenshot lands well under it.
  maxBytes: 512 * 1024,
  jpegQuality: 80
} as const

export interface ImageContent {
  readonly type: 'image'
  readonly data: string
  readonly mimeType: string
}

export interface ShrunkImage {
  readonly data: string
  readonly mimeType: string
  readonly originalWidth: number
  readonly originalHeight: number
  readonly width: number
  readonly height: number
  readonly wasResized: boolean
}

/** The SDK's `resizeImage`, or a stand-in: null means it could not be done. */
export type Shrink = (
  bytes: Uint8Array,
  mimeType: string,
  limits: typeof IMAGE_LIMITS
) => Promise<ShrunkImage | null>

interface ToolContent {
  readonly type: string
  readonly text?: string
  readonly data?: string
  readonly mimeType?: string
}

interface ToolResult {
  content: ToolContent[]
}

function isImage(content: ToolContent): content is ImageContent & ToolContent {
  return content.type === 'image' && typeof content.data === 'string'
}

// The SDK reports `wasResized` for any re-encode, so the dimensions say
// whether coordinates moved.
function note(after: ShrunkImage): string {
  const scaled = after.width !== after.originalWidth || after.height !== after.originalHeight
  const scale = after.originalWidth / after.width
  const size = scaled
    ? `${after.originalWidth}x${after.originalHeight} shown at ${after.width}x${after.height}; multiply coordinates by ${scale.toFixed(2)} to reach the original`
    : `${after.width}x${after.height}`
  return `[Image shrunk to fit the request: ${size}, ${after.mimeType}.]`
}

/**
 * One image, brought under the budget. An image already under it comes back
 * as it was; one that cannot be shrunk comes back as it was too, since the
 * SDK has already vouched for it once and a failed shrink is not a reason to
 * lose the picture.
 */
export async function shrinkImage(
  image: ImageContent,
  shrink: Shrink
): Promise<{ image: ImageContent; note?: string }> {
  if (image.data.length <= IMAGE_LIMITS.maxBytes) return { image }
  const bytes = new Uint8Array(Buffer.from(image.data, 'base64'))
  let shrunk: ShrunkImage | null
  try {
    shrunk = await shrink(bytes, image.mimeType, IMAGE_LIMITS)
  } catch {
    shrunk = null
  }
  if (shrunk === null || shrunk.data.length >= image.data.length) return { image }
  const after: ImageContent = { type: 'image', data: shrunk.data, mimeType: shrunk.mimeType }
  return { image: after, note: note(shrunk) }
}

/**
 * A read tool whose images arrive shrunk. Everything else about `base` is
 * kept: its name, so it replaces π's builtin read in the registry; its
 * description and schema, so the model sees no difference.
 */
export function readToolWithShrunkImages(base: ToolDefinition, shrink: Shrink): ToolDefinition {
  return {
    ...base,
    async execute(...args: Parameters<ToolDefinition['execute']>) {
      const result = (await base.execute(...args)) as ToolResult
      const content: ToolContent[] = []
      const notes: string[] = []
      for (const block of result.content) {
        if (!isImage(block)) {
          content.push(block)
          continue
        }
        const { image, note: said } = await shrinkImage(block, shrink)
        content.push(image)
        if (said !== undefined) notes.push(said)
      }
      if (notes.length === 0) return { ...result, content }
      // The read tool leads with a text block naming the file; the note goes
      // with it so the model reads about the image before it sees it.
      const first = content.findIndex((block) => block.type === 'text')
      if (first === -1) content.unshift({ type: 'text', text: notes.join('\n') })
      else content[first] = { ...content[first], text: `${content[first].text}\n${notes.join('\n')}` }
      return { ...result, content }
    }
  } as ToolDefinition
}

type ReadSdk = Pick<
  typeof import('@earendil-works/pi-coding-agent'),
  'createReadToolDefinition' | 'resizeImage'
>

/** π's own read tool for `cwd`, shrinking with π's own resizer. */
export function shrinkingReadTool(pi: ReadSdk, cwd: string): ToolDefinition {
  // The typed schema narrows the TUI renderers; π registers by the wide type.
  const base = pi.createReadToolDefinition(cwd) as unknown as ToolDefinition
  return readToolWithShrunkImages(base, (bytes, mimeType, limits) =>
    pi.resizeImage(bytes, mimeType, limits)
  )
}
