# 0001 — The UI reaches agents only through the agent port

The Electron app is built on the π SDK, but UI testability is the project's
first requirement: agents working in this repo must drive the app — send a
chat message, see the response rendered — without a paid API call, and the
project may one day leave the π SDK entirely. We therefore decided that the
renderer never touches the SDK or its types: it talks only to a
Crucible-owned agent port (prompt in, event stream out), implemented by a
fake adapter (canned responses, the dev/test default) and an SDK adapter
(the real π SDK, living in the main process behind typed IPC). The
indirection is bought deliberately: deterministic UI tests and prototyping
against the fake, and SDK independence, in exchange for one extra layer.

## Considered Options

Mocking the π SDK's own interfaces (`AgentSession` etc.) directly was
rejected: it couples every test to a type surface we don't control and
leaves no seam for replacing the SDK.
