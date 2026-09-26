import { parentPort } from 'node:worker_threads'

// The worker `warmInWorker` starts: π's whole module graph, imported once off
// the main thread so every file in it has been opened before the main thread
// imports the same graph. It reports and is ended; nothing it loads is used.
// A failed import is thrown out of the worker, which ends the warm-up and
// leaves the main thread to import on its own and meet the same error there.
void Promise.all([
  import('@earendil-works/pi-coding-agent'),
  import('@earendil-works/pi-ai')
]).then(() => parentPort?.postMessage('warmed'))
