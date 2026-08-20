import type { ImageAttachment } from '../../shared/agent/port'

// What Crucible accepts as an attachment, and what it refuses out loud. No
// file is ever dropped silently: every refusal names the file and the reason.

export const ACCEPTED_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp'
]

/** Per image, of original file bytes (Q11). */
export const MAX_BYTES = 10 * 1024 * 1024

export type Refusal = string

/** The reason this file cannot be attached, or nothing when it can. */
export function refuse(file: { name: string; type: string; size: number }): Refusal | undefined {
  if (!ACCEPTED_TYPES.includes(file.type)) {
    return `${file.name} is not an image Crucible can attach — png, jpeg, gif and webp are.`
  }
  if (file.size > MAX_BYTES) {
    return `${file.name} is ${megabytes(file.size)} MB, over the 10 MB limit for one image.`
  }
  return undefined
}

function megabytes(bytes: number): string {
  return (Math.round((bytes / (1024 * 1024)) * 10) / 10).toFixed(1)
}

/** Base64 without the `data:` prefix, which is what the port carries. */
export async function readAttachment(file: File): Promise<ImageAttachment> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  // In chunks, because a ten-megabyte spread would overflow the argument list.
  const chunk = 0x8000
  for (let at = 0; at < bytes.length; at += chunk) {
    binary += String.fromCharCode(...bytes.subarray(at, at + chunk))
  }
  return { mimeType: file.type, data: btoa(binary) }
}
