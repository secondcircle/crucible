import type { Channel, Message } from '../workflows/host/protocol.ts'

// How a host process reaches the main process that started it. Under Electron
// that is a utility process's parent port; under plain Node, as the tests run
// a host, it is Node's IPC channel. The same entry adapts to both.

/** Electron's parent port when there is one; Node's IPC channel otherwise. */
export function openParentChannel(who: string): Channel {
  const parentPort = (
    process as unknown as {
      parentPort?: {
        postMessage(message: unknown): void
        on(event: 'message', listener: (event: { data: Message }) => void): void
        start?(): void
      }
    }
  ).parentPort
  if (parentPort !== undefined) {
    parentPort.start?.()
    return {
      post: (message) => parentPort.postMessage(message),
      onMessage: (listener) => parentPort.on('message', (event) => listener(event.data))
    }
  }
  if (typeof process.send !== 'function') {
    process.stderr.write(`${who}: no channel to the main process\n`)
    process.exit(2)
  }
  return {
    post: (message) => {
      process.send?.(message)
    },
    onMessage: (listener) => {
      process.on('message', (message) => listener(message as Message))
    }
  }
}
