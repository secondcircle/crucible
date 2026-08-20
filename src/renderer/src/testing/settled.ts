import { act } from '@testing-library/react'

// The shell's listeners and its first fetch are effects, so without this a
// test drives a half-mounted document, intermittently.
export async function settled(): Promise<void> {
  await act(async () => {})
}
