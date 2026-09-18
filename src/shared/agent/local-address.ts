// The one carve-out from "a web link opens in the OS browser": a local address
// is what the context panel is for — a dev server, a page an agent just put up.
// Shared because two sides must agree on it: the renderer draws such a link as
// one that opens a tab, and main decides what it will actually open.

export function isLocalAddress(address: string): boolean {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1'
}
