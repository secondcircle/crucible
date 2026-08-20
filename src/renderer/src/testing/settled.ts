import { act } from '@testing-library/react'

// A committed render is not a run effect, and the shell's listeners and its
// first fetch are both effects: without this a test drives a half-mounted
// document, intermittently.
export async function settled(): Promise<void> {
  await act(async () => {})
}
