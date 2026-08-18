/**
 * The two IPC channel names the agent channel is built on (D6, D7).
 *
 * They are the one fact the preload surface and the main-process handler have
 * to agree on letter for letter, and a mismatch between them is silent in
 * TypeScript and invisible until a prompt goes unanswered in a running app — so
 * both spellings live here, and neither side writes the string itself.
 *
 * This module imports nothing, like the port's type module beside it, and the
 * renderer never sees it: the channel names are behind the preload surface, and
 * the IPC client knows `window.crucible.agent`, not a channel.
 */

/** Invoke: a prompt goes out, a turn id comes back. */
export const PROMPT_CHANNEL = 'agent:prompt'

/** Send: main pushes one port event per message at the window. */
export const EVENT_CHANNEL = 'agent:event'
