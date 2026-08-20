import { waitFor } from '@testing-library/react'

// An untitled row shares its name with the button that creates sessions, so a
// test that wants the rows asks the sidebar rather than guessing at a name.

export function sessionRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.side .sess')]
}

export async function sessionsShown(): Promise<void> {
  await waitFor(() => {
    if (sessionRows().length === 0) throw new Error('the sidebar has no session rows yet')
  })
}
