import { waitFor } from '@testing-library/react'

// A session row is named by its title, and an untitled one shares its name with
// the button that creates sessions, so a test that only wants "the rows" asks
// the sidebar for them rather than guessing at a name.

/** The sidebar's session rows, in the order the sidebar shows them. */
export function sessionRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.side .sess')]
}

/** Waits until the first snapshot has put this workspace's sessions on screen. */
export async function sessionsShown(): Promise<void> {
  await waitFor(() => {
    if (sessionRows().length === 0) throw new Error('the sidebar has no session rows yet')
  })
}
