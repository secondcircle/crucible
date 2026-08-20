import { act } from '@testing-library/react'

/**
 * One flush of everything mounting the shell set in motion, awaited before a
 * test drives it.
 *
 * A query that finds the sidebar proves the render committed, not that React
 * has run that commit's effects. The shell registers its document-level paste,
 * drop and Escape listeners in one of those effects and fetches the open
 * session's transcript in another, so a test that starts firing events first is
 * driving a half-mounted document. It does that only sometimes, which is the
 * worst way to find out.
 */
export async function settled(): Promise<void> {
  await act(async () => {})
}
