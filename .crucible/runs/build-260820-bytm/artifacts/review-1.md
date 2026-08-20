# Review 1 — interior review of the exhibit-origin-hardening branch

**Branch**: `git diff main...HEAD` (one commit, `65b3ba1 build: builder`).
**Standard**: spec at `.crucible/runs/build-260820-bytm/artifacts/spec.md`, intent
brief at `.crucible/align/260820-exhibit-origin-hardening.md`.

**Verdict: approved.** No findings. Everything I ran is listed below so the
next reviewer or the merge gate can retrace it.

## What I verified, and how

### The suite, lint, typecheck

All green in this worktree:

```
npm test        # 56 files, 602 tests, all passing; no Electron, no SDK adapter
npm run lint    # clean
npm run typecheck  # clean (node + web)
```

### The shared URL module (`src/shared/agent/exhibit-url.ts`)

- Imports only the port's two id aliases. No Electron, no Node, no SDK types,
  as the spec's `port.ts`-style discipline demands.
- Builder and parser round-trip encoded ids; the parser refuses wrong scheme,
  wrong host, host-with-port, credentials, wrong segment count, empty decoded
  segments, trailing slash, query, fragment, malformed percent-encoding, and
  non-URLs. All of these are asserted in `serve-exhibit.test.ts` ("the shared
  URL format" block), which the spec allows as the home for these assertions.
- One behavior worth knowing, not a defect: WHATWG `URL` normalizes literal
  `..` path segments before the parser sees them, so
  `exhibit://panel/s1/../../etc/passwd` reaches the parser as
  `exhibit://panel/etc/passwd` and falls into the exact-lookup miss rather
  than the segment-count refusal. Either way it is refused with no disk read,
  which the traversal test proves.

### The decision function (`src/main/panel/serve-exhibit.ts`)

- Plain function of `(panel, {method, url})`, exactly the testable split the
  spec demands; the Electron wiring in `exhibit-scheme.ts` is a three-line
  translation into `Response`.
- Served response carries exactly the spec's three headers, including the CSP
  string verbatim (`default-src 'none'; script-src 'unsafe-inline';
  style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri
  'none'`). Asserted byte-for-byte in the "answers an open HTML tab" test.
- Bytes are read at request time (`readFileSync` per request, never cached);
  the fresh-bytes test rewrites the file and gets the new bytes.
- Refusals: 404, `text/plain`, `no-store`, same CSP, fixed sentences, nothing
  of the request reflected. Both bodies match the spec's wording exactly.
- The test suite's `readFileSync` spy proves refused requests (unknown,
  smuggled, markdown, non-GET) read nothing from disk. Resolution is an exact
  string lookup through the model's new `exhibitFile` query; no URL part is
  ever treated as a path.
- All seven spec-required handler tests exist and pass: served, fresh bytes,
  unknown session/tab, vanished file, traversal shapes (including encoded
  separators, extra segments, query, fragment, wrong host, `file:`), markdown
  refused, closed refused. Reset-refuses and non-GET-refuses are there as
  extras.

### The model's growth (`src/main/panel/model.ts`)

- Exactly one read-only query added (`exhibitFile`), returning path and kind
  off the existing `findTab`. Tool semantics, dedupe, ages, persistence,
  restore-and-drop untouched. The lazy load from persistence applies through
  `panelOf` as it does everywhere else, which is what the spec asked for.
- One nit I am deliberately not raising as a finding: the comment on
  `exhibitFile` says "Reads nothing off disk", which is true of the query
  itself but not of the first `panelOf` for a session (the existing lazy
  restore stats files). The behavior is exactly what the spec prescribes;
  only the comment is slightly generous, and comments belong to the later
  gate anyway.

### Registration and wiring (`src/main/index.ts`, `exhibit-scheme.ts`)

- `registerExhibitScheme()` runs at module top level, before `app.whenReady`,
  with `{standard: true, secure: true}` and no `bypassCSP`. The window uses
  the default session (no partition in `createMainWindow`), which is the
  session the handler is installed on. `src/main/index.test.ts` asserts the
  ordering: privileges claimed before ready, handler installed after.
- The agent port's shape is unchanged: no new operations, no changed
  signatures, no new event types. The handler sits under the one panel model
  both adapters already delegate to.

### The renderer (`index.html`, `ContextPanel.tsx`, `Shell.panel.test.tsx`)

- `script-src` is `'self'` alone; the justifying comment is gone; `frame-src
  exhibit:` is added with a short comment. `grep unsafe-inline
  src/renderer/index.html` finds only `style-src 'self' 'unsafe-inline'`,
  which the spec's precision note explicitly permits (React inline styles
  predate this work and were never the finding).
- No `srcdoc` remains anywhere under `src/renderer` (grepped). The HTML frame
  carries `src={exhibitUrl(...)}`, `sandbox="allow-scripts"` exactly, and a
  React key of `sessionId:tabId:shownAt` so a re-show remounts the frame.
- The renderer makes no `exhibit` port call for HTML tabs (asserted against
  the scripted port); markdown keeps its whole existing path, and its render,
  refresh-refetch, and inline-failure tests stand unmodified in the diff.

### The lint fence (`eslint.config.mjs`)

Demonstrated, both spellings, with scratch files (created, linted, removed):

- JSX attribute: `<div dangerouslySetInnerHTML={{__html: ...}} />` in a
  renderer `.tsx` fails `npm run lint` with the spec's stance in the message.
- Object property: `const props = { dangerouslySetInnerHTML: {...} }` in a
  renderer `.ts` fails the same way.

### The fake-flavor walk (integration acceptance)

The human's own `dev:sdk` instance holds port 9222 from the main repo, so I
launched this worktree's fake-flavor app on 9223 instead
(`npx electron-vite dev --remoteDebuggingPort=9223`), connected
`agent-browser`, opened a session in the `crucible-ember-shell` workspace,
and sent "show me the panel". Observed in the live app, then cleaned up my
instance (the human's 9222 app was never touched):

- The Benchmark tab's iframe: `src="exhibit://panel/<uuid>/benchmark"`,
  `sandbox="allow-scripts"`, no `srcdoc` anywhere in the document.
- The live renderer CSP meta: `default-src 'self'; script-src 'self';
  style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src exhibit:`.
- Inside the frame: the computed score **"9.2 ms"** and **"6 samples measured
  by this page's own script"**, both written by the exhibit's own inline
  script. So the script ran under the exhibit origin while the renderer's
  policy forbids inline script, which is the whole point of the work.
- The frame's document is an opaque origin from the renderer's side
  (`contentDocument` unreachable), and a renderer-side `fetch()` of an
  exhibit URL is blocked by the renderer's own `default-src 'self'`, so the
  scheme is reachable as a frame and nothing else. Both are stricter than
  required and worth knowing.

## Judgment

The interior is sound. The decision function is where the spec put it, the
traversal stance is structural (exact id lookup, no path handling), the
headers match the spec character for character, the renderer CSP is back to
`'self'`, both lint spellings fire, and the integration fact the unit tests
cannot show (a sandboxed frame actually loading the custom scheme) holds in
the real app. Nothing must change before a human decides this branch's fate.
