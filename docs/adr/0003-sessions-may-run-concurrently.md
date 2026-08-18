# 0003 — Sessions may run concurrently

A workspace can hold several active sessions, and switching away from a working session must not stop it or prevent work in another session. Crucible therefore permits concurrent agent work across sessions, keeps each session's work and status independently addressable, and applies Stop or Escape only to the active session. This replaces the boilerplate's app-global single-flight assumption: the extra multiplexing is deliberate because background work and useful session switching are part of the dogfooding floor, not a later optimization.

## Considered Options

Keeping one live turn across the whole app was rejected because a long-running session would block every other session and make the sidebar's working state misleading.
