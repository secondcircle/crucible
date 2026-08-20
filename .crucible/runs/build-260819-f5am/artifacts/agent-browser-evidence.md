# Evidence — driving the Ember shell with Agent Browser

**Run:** `build-260819-f5am` · **Date:** 2026-08-19 · **Flavor:** fake (zero cost)

The two manual proofs A11 asks for: render a code block, and stop a live turn.
Both were driven through the shipped window over Chromium remote debugging, with
the fake adapter — no network, no paid call, nothing stubbed inside the app.

No paid SDK proof is part of this work. `npm run prove:sdk` was **not** run:
neither interview authorized it, and `AGENTS.md` requires separate explicit
human authorization.

## How it was driven

```
rm -f ~/Library/Application\ Support/crucible/shell-state.json   # a first launch
mkdir -p /tmp/crucible-proof-ws                                  # the seeded workspace
CRUCIBLE_WORKSPACE=/tmp/crucible-proof-ws npm run dev
agent-browser connect 9222
```

`npm run dev` bound `127.0.0.1:9222` (`DevTools listening on
ws://127.0.0.1:9222/...`), and `lsof -nP -iTCP:9222 -sTCP:LISTEN` showed the one
Electron process holding it.

## 1 · A launch with a seeded workspace and no session (WS-6, WS-7, SE-9)

The seeded folder is present and active without any OS dialog, the main region
offers the one thing there is to do, and the composer is not usable:

```
- navigation "Workspaces and sessions"
  - button "New session"
  - StaticText "WORKSPACES"
  - button "crucible-proof-ws"
  - button "Resume session…"
  - button "＋ Add workspace"
- main
  - sectionheader
    - StaticText "No session"
    - StaticText "crucible-proof-ws"
    - StaticText "— ctx"                     ← no usage reported yet (TB-2)
  - paragraph: "No session in this workspace."
  - button "New session"
  - textbox "Message" [disabled]
  - button "Model: none" [disabled]
  - button "Send" [disabled]
```

## 2 · New Session, a prompt, and a rendered code block (SE-1, TR-1, TL-1, TH-1)

Clicked **New session**, typed into the composer, pressed Enter. The reply
streamed and rendered as markdown — thinking block, a tool chip that ran and
finished, a list, inline code, a table, and a fenced block:

```
- log "Transcript"
  - generic "You": "Render a fenced code block, please."
  - button " thought for 1s" [expanded=false]          ← dim, collapsed, measured
  - button "bash npm test" ... StaticText "done"        ← event-backed tool chip
  - generic "Agent"
    - paragraph "The fake adapter answers every prompt with this same scripted turn…"
    - list: "a thinking block, dim and collapsed" / "a tool call that runs, …" /
            "markdown with `inline code`, a table and a fenced block"
    - table: flavor|cost|default · fake|none|yes · sdk|metered|no
    - code "const adapter = createFakeAdapter({ pauseMs: 0 })
            await adapter.prompt(sessionId, turnId, 'hello')"
    - paragraph "Stop or Escape ends this turn wherever it stands."
```

Screenshot: `reply.png`. On WIN-1 the honest claim is narrower than "I watched
for a flash": the window is created with `backgroundColor: #191419`, the
document carries the same background inline in `index.html`, and the window is
shown only on `ready-to-show` — the three settings that have to agree, and they
do. Every screenshot taken here is Ember from edge to edge.

Afterwards the top bar showed real usage rather than a placeholder:
`0% ctx · 260 / 200k` — the fake adapter's own arithmetic, reported after the
turn.

## 3 · Stopping a live turn (CAN-1, CAN-2, CAN-5, TL-2)

Sent a second prompt and clicked **Stop** ~320 ms in, while the tool call was
still running. The partial output stayed, the chip stopped claiming anything it
never learned, and the quiet marker closed the turn:

```
  - generic "You": "Now stream so I can stop you mid-tool."
  - button " thought for 1s"
  - button "bash npm test" ... StaticText "stopped"     ← never reported an outcome
  - StaticText "STOPPED"
```

Screenshot: `stopped.png`.

Escape does the same thing: an earlier pass in the same window stopped a turn
with `esc` and produced the identical marker.

## 4 · The redirect (CAN-5)

Immediately after the stop, `Redirect after the stop.` sent normally and ran to
completion in the same session — same sidebar entry, same conversation.

## 5 · What the run log recorded

From `logs/2026-08-19T20-27-44-821Z.jsonl`, the sequence for the three turns
above (every port operation and event is logged main-side, LF-2):

```
  2 adapter_selected adapter=fake requested=None
 13 createSession
 18 prompt "Render a fenced code block, please."
 20 turn_started
 25 tool_started
 29 tool_ended
 43 turn_ended
 46 prompt "Now stream so I can stop you mid-tool."
 48 turn_started
 53 tool_started
 56 cancel (active session)
 57 turn_cancelled          ← cancelled is its own outcome, and nothing follows it
 60 prompt "Redirect after the stop."
 62 turn_started
 67 tool_started
 71 tool_ended
 85 turn_ended
```

## 6 · Extra checks made in the same window

- **Resume (RES-1..RES-5).** "Resume session…" opened the overlay, which listed
  the fake adapter's canned entries plus the conversation of the live session,
  each with a display-safe preview and a relative time and no path or filename.
  Choosing a canned one added a curated entry and restored its transcript;
  choosing a conversation that was already curated activated that entry instead
  of adding a second (the sidebar stayed at two sessions).
- **A reload (TR-7).** Reloading the renderer mid-session restored the
  transcript through `transcript()` with the same item kinds the live stream
  produced, stopped marker included.
- **A relaunch (WS-5, A20).** Quitting and launching again *without*
  `CRUCIBLE_WORKSPACE` restored the workspace, both curated sessions, and the
  last active one. The store file that did it holds only Crucible's own facts:

  ```json
  { "version": 1,
    "workspaces": [{ "id": "e5ceea8b-…", "path": "/tmp/crucible-proof-ws" }],
    "sessions": [{ "id": "11defcb7-…", "workspaceId": "e5ceea8b-…",
                   "createdAt": "2026-08-19T20:22:49.688Z",
                   "token": "fake-live-3", "model": "fake/deterministic",
                   "thinkingLevel": "low" }],
    "activeSessionByWorkspace": { "e5ceea8b-…": "11defcb7-…" },
    "activeWorkspaceId": "e5ceea8b-…" }
  ```

  No π path, filename or storage concept anywhere in it (A28).

## Repository checks

```
make validate      → typecheck, lint, 199 tests, build — all green, twice in a row
npm test           → 21 files, 199 tests, no paid call, no SDK adapter constructed
```

## Re-check after the review fix (cancel during the bind window)

Added by the fixer after review-1's finding was fixed in `src/main/shell/shell.ts`.
Same fake flavor, zero cost: `CRUCIBLE_WORKSPACE=/tmp/crucible-fix-ws npm run dev`,
`agent-browser connect 9222`.

The launch still comes up on the seeded workspace with no session (WS-6, WS-7,
SE-9), New Session creates and activates one, and a prompt renders the scripted
turn: thinking block, tool chip, markdown reply with a table and a fenced block.

Stop mid-stream still lands, which is the path the fix touches from the other
side. Driven in one page-side step so the click happens while the turn is live:

```
agent-browser eval '(async () => { ...type, Enter, wait 500ms,
  click button.send.working, wait 1200ms... })()'
→ {"stopShown":true,
   "tail":"YOU\nstop me mid stream\n▸ thought for 1s\n▸ bash npm test done\n
           AGENT\nThe fake adapter answers every prompt with this same scripted
           turn. Nothing was sent anywhere and nothing was paid for it.\n
           STOPPED\n…"}
```

The Stop control was showing while the turn ran, the reply is cut where the stop
landed, and the quiet stopped marker closes it (CAN-1, CAN-2). Screenshot:
`stopped-after-fix.png`.

```
npm run lint / npm run typecheck / npm test → green, 22 files, 203 tests
```

## Re-check after the review-2 fix (the two conversation guards)

Fake flavor again, fresh store, `CRUCIBLE_WORKSPACE=/tmp/crucible-fix2-ws npm run
dev`, `agent-browser connect 9222`. The fix reads `SessionView.loaded` before a
guard is allowed to skip its question, so what had to be seen is both sides of
that: a conversation known to be empty still skips, and everything else asks.

- New session, session menu, **Reset session**: applied with no dialog. Its
  history had landed and held nothing, which is the one case that may skip.
- Prompted once (the scripted turn rendered: thinking block, tool chip, list,
  table, fenced block, `0% ctx · 199 / 200k`). Then **think: low → high** raised
  "Invalidate this session's cache?" and only after "Change anyway" did the chip
  read `think: high` (MO-7). **Reset session** on the same conversation raised
  "Reset this session?"; "Keep the conversation" left the transcript intact
  (SE-7). Screenshot: `guards-after-fix.png`.
- Reloaded the renderer so the session came back through `transcript()`, the
  path the finding was about. Reset asked, "Reset anyway" emptied the
  conversation under the same sidebar entry, and a second Reset on the now-empty
  session asked nothing.

The loading window itself is seconds long only on the SDK flavor, so it is
pinned by `src/renderer/src/Shell.guards-before-history.test.tsx` (review 2's
two tests, with `transcript()` gated open) rather than by hand here.

```
npm run lint / npm run typecheck / npm test → green, 23 files, 205 tests
```
