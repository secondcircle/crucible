# 0011 — Conversation tokens are flavor-scoped

A session minted under the fake adapter stored the token `fake-live-3`; the
next SDK launch handed it to π, which read it as a path and wrote a session
file of that name into the repository root, twice in one day. A conversation
token is minted by one launch flavor's adapter and is meaningful only to that
adapter, so the store keeps the minting flavor beside the token and the shell
offers a stored token back only when that flavor matches the running one. The
token itself stays opaque: nothing above the agent port parses it, and no
adapter ever sees another's. A token whose flavor differs, or a token from
before this contract that carries no flavor at all, is treated as absent: the
session binds fresh behind the same sidebar identity, with session-reset
semantics, and the bind's own token and flavor replace what was there, so the
mismatch resolves once instead of every launch. The guard lives in the shell,
above the port, which is why neither adapter changed.

## Considered Options

Encoding the flavor in the token string, so any reader could tell a
`fake:`-prefixed token from an `sdk:` one, was rejected because it makes token
contents meaningful: adapters would start parsing, and eventually writing,
each other's namespace, and the opacity that lets the port be replaced would
be gone. Keeping the scope in the store costs one optional field and leaves
the token a string only its own adapter reads.
