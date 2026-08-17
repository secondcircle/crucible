# Evidence — Crucible Electron boilerplate (agent port, testability)

**Date:** 2026-08-17  
**Run:** `steer-260817-zb2v`  
**Role:** research (steer)  
**This file is not a design.** It records what was checked, what is true on disk / in primary sources, prior art worth copying, domain words, constraints, candidate seams, and open uncertainties. Claims I could not verify myself are marked **UNVERIFIED**.

---

## 2026-08-17 — first pass

### How this was checked

Read on disk:

- `/Users/ike/repos/crucible/.crucible/align/260817-electron-boilerplate.md`
- `/Users/ike/repos/crucible/CONTEXT.md`
- `/Users/ike/repos/crucible/AGENTS.md`
- `/Users/ike/repos/crucible/docs/adr/0001-ui-reaches-agents-only-through-the-agent-port.md`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md` (first ~150 lines + protocol overview)
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/sdk/{README.md,01-minimal.ts,09-api-keys-and-oauth.ts,11-sessions.ts,12-full-control.ts}`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/package.json`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/json-event.d.ts`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/client/{index.d.ts,transcript.d.ts}`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/types.d.ts` (`AgentEvent`)
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/types.d.ts` (`AssistantMessageEvent`)
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-protocol/dist/{index.d.ts,schemas.d.ts}`
- `/Users/ike/repos/pi-extensions/{CONTEXT.md,AGENTS.md,package.json,.gitignore}`
- `/Users/ike/repos/pi-extensions/skills/agent-browser/SKILL.md`
- `/Users/ike/repos/pi-extensions/docs/adr/` (filenames only)
- `~/.pi/agent/settings.json` (full); `~/.pi/agent/auth.json` (top-level keys only; secret values not read into this file)

Commands (local):

- `ls -la /Users/ike/repos/crucible`; `find /Users/ike/repos/crucible` (repo inventory)
- `git status` in this repo → `fatal: not a git repository`
- `node -v` → `v25.9.0`; `npm -v` → `11.12.1`; `which node` → nvm `v25.9.0`
- `which pi`; `pi --version` → `0.84.2` at `/opt/homebrew/bin/pi`
- `which agent-browser`; `agent-browser --version` → `0.34.0`
- `agent-browser skills list`; `agent-browser skills get electron`; `agent-browser skills get core`
- `node --input-type=module -e "import { createAgentSession } from '@earendil-works/pi-coding-agent'"` from this repo → `ERR_MODULE_NOT_FOUND`
- `test -f ~/.pi/agent/auth.json` → exists; `ls ~/.pi/agent/`
- `npm view` for: `electron-vite@5.0.0`, `create-electron-vite@0.7.1`, `@quick-start/create-electron@1.0.30`, `electron` (latest `43.4.0`), `vitest@4.1.10`, `@testing-library/react@16.3.2`, `jsdom@30.0.1`, `happy-dom@20.11.2`, `electron-log@5.4.4`, `pino@10.3.1`, `@playwright/experimental-ct-react@1.62.1`, `react@19.2.8`, `@vitejs/plugin-react@6.0.5`

Primary external sources fetched 2026-08-17:

- https://github.com/alex8088/electron-vite README (raw, HTTP 200)
- https://raw.githubusercontent.com/alex8088/quick-start/master/packages/create-electron/playground/react-ts/* (official `react-ts` playground: `package.json`, `electron.vite.config.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/preload/index.d.ts`, `src/renderer/src/{main.tsx,App.tsx}`, `src/renderer/index.html`, tsconfigs, `.gitignore`, `eslint.config.mjs`)
- https://electron-vite.org/guide/, `/guide/dev`, `/guide/hmr-and-hot-reloading`, `/guide/isolated-build`, `/guide/troubleshooting`, `/guide/typescript` (VitePress HTML; text extracted from `<main>`)
- https://raw.githubusercontent.com/electron/electron/main/docs/tutorial/{security.md,context-isolation.md,sandbox.md,ipc.md}
- https://raw.githubusercontent.com/electron/electron/main/docs/api/web-contents.md (`console-message`, `preload-error`)
- https://raw.githubusercontent.com/megahertz/electron-log/master/{README.md,docs/transports/file.md,docs/transports/format.md}
- https://raw.githubusercontent.com/electron-vite/create-electron-vite/main/{README.md,template-react-ts/package.json,electron/main.ts,electron/preload.ts,electron/package.json}
- https://raw.githubusercontent.com/alex8088/electron-toolkit/master/packages/preload/README.md

Not fetched / failed:

- Michael Feathers primary text (informit.com timed out; no Wikipedia article at `Seam_(software_development)`). Verbatim book wording is **UNVERIFIED** below.
- GitHub API listings sometimes returned non-JSON (rate/HTML). File contents from `raw.githubusercontent.com` that returned HTTP 200 are used instead.

---

### What exists today in this repository

The working tree is residue plus this steer run. There is no application yet.

Verified inventory (2026-08-17):

| Path | What it is |
| --- | --- |
| `AGENTS.md` | Standing frame: Electron app on π SDK (not TUI); legacy system is `../pi-extensions`; points at `CONTEXT.md` and `docs/adr/`. |
| `CONTEXT.md` | Glossary: **Crucible**, **legacy system**, **agent port**, **fake adapter**, **SDK adapter**. |
| `docs/adr/0001-ui-reaches-agents-only-through-the-agent-port.md` | The only ADR. |
| `.crucible/align/260817-electron-boilerplate.md` | Intent brief for this work. |
| `.crucible/inspector.html` | Workflow inspector HTML (run UI, not the product). |
| `.crucible/runs/steer-260817-zb2v/` | This steer run. |
| `.firecrawl/frontend-design-skill.md`, `.firecrawl/t3-chat-review.md` | Present on disk as of this pass; not referenced by the brief or ADR. Not treated as product source. |

Absent (verified by `ls` / `find` / `git status`):

- No `.git/`
- No `.gitignore`
- No `package.json`, lockfile, `node_modules/`, `src/`, `logs/`
- No Electron main/preload/renderer
- No tests, lint config, tsconfig
- No CI, no packaging config

`git status` in `/Users/ike/repos/crucible`: `fatal: not a git repository (or any of the parent directories): .git`. Parent `/Users/ike/repos` is also not a git repo.

Implication: every application file for this milestone will be new. The brief's Q9 ("Nothing copied from the legacy repo — no file lands in this repo unless it was discussed and decided here") is mechanically easy to keep because there is nothing to merge from.

---

### Domain vocabulary (use these words exactly)

From `CONTEXT.md` (only writer: `/align`):

- **Crucible** — the whole app (workflow engine + this Electron surface). Not "just the UI".
- **legacy system** — `../pi-extensions`. Read-only reference. Nothing here depends on it at runtime. Avoid: "the old app", "the extensions repo".
- **agent port** — Crucible-owned interface between the UI layer and everything agent-side. Prompt in, event stream out. The only path the UI uses to reach an agent. Avoid: "SDK wrapper", "mock boundary".
- **fake adapter** — agent-port implementation with canned responses; no network, no cost. Default in dev; what agents and tests drive. Avoid: "mock", "stub".
- **SDK adapter** — agent-port implementation backed by the real π SDK. Avoid: "real backend", "live mode".

ADR 0001 rejected mocking π SDK types (`AgentSession` etc.) directly: that would couple tests to a type surface this repo does not control and leave no seam for replacing the SDK.

---

### Constraints and non-negotiables (from the brief + ADR; not invented here)

Quoted / paraphrased only from `/Users/ike/repos/crucible/.crucible/align/260817-electron-boilerplate.md` and ADR 0001:

1. Stack is **electron-vite + React + TypeScript** (Q3).
2. Renderer never imports the π SDK or its types. Agent port is the only path (ADR 0001, Q4/Q5).
3. π SDK lives in the **Electron main process behind typed IPC**; renderer sandboxed (**contextIsolation on, nodeIntegration off**) (Q4, DoD 1). Q4 is flagged in the brief as *proposed-and-accepted*, cheap to revisit.
4. Fake adapter is the default everywhere agents operate. Agents must never need a paid API call to verify the app (Q6, Q11/Q14).
5. SDK adapter is in milestone 1, chat-only: send prompt, stream text back — "the single thinnest tracer bullet through the whole stack", proven against the real SDK once (Q11/Q14).
6. Test layers: **unit and component tests only**. No browser E2E suite (Q6). Binding requirement instead: an agent launches the app, drives it with Agent Browser, sends a chat message, confirms the reply — at zero API cost (DoD 5).
7. Walking-skeleton chat pane, unstyled (DoD 3). No styling/design work this run.
8. Structured JSONL logging to a known repo-local, gitignored location (e.g. `logs/`): main lifecycle, every agent-port call and event (which adapter, prompt, stream events, errors), IPC failures, renderer errors/console forwarded into **one chronological stream**. One meaningful test that forwarding works (Q16, DoD 6).
9. Lint, typecheck, and test scripts wired (DoD 7).
10. Out of scope this run: packaging/auto-update, CI, styling, browser E2E, login UI, legacy feature migration, copying files from the legacy system (Q9, Constraints).
11. SDK adapter relies on credentials already on disk from TUI use. Login/logout is a planted flag, own align (Q12).

Definition of done is the seven-point list in the brief (Q8 as amended by Q16).

---

### π SDK surface the SDK adapter would wrap

Installed copy checked: `@earendil-works/pi-coding-agent@0.84.2` at `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`. `engines.node`: `>=22.19.0`. CLI `pi` on PATH is the same version.

This repo cannot import the package today (`ERR_MODULE_NOT_FOUND` from `/Users/ike/repos/crucible`). A future `package.json` would have to declare the dependency. Peer/runtime note from the legacy system's `package.json`: `"@earendil-works/pi-coding-agent": "^0.84.1"` as a peer, `"*"` in `peerDependencies`.

#### Factory and session (from `docs/sdk.md` and `dist/core/agent-session.d.ts`)

Minimal published example (`examples/sdk/01-minimal.ts`):

```ts
import { createAgentSession } from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession();

try {
	session.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});
	await session.prompt("What files are in the current directory?");
} finally {
	session.dispose();
}
```

`AgentSession.prompt(text, options?)` — "Send a prompt and wait for completion". Resolves only after the accepted run finishes. During streaming, `streamingBehavior: "steer" | "followUp"` is required or it throws.

`AgentSession.subscribe(listener)` returns an unsubscribe function.

Docs also export `SessionManager.inMemory()`, `SettingsManager.inMemory(...)`, `ModelRuntime.create()`, `noTools: "all" | "builtin"`. Chat-only tracer can turn tools off; that option is documented, not exercised here.

Auth (docs + `examples/sdk/09-api-keys-and-oauth.ts`): `ModelRuntime.create()` defaults to `~/.pi/agent/auth.json` and `~/.pi/agent/models.json`. Resolution order: runtime overrides → stored credentials → env vars → fallback resolver.

On this machine (2026-08-17):

- `~/.pi/agent/auth.json` exists (mode `0600`). Top-level keys: `anthropic`, `openai-codex`, `xai`. Secret values not recorded.
- `~/.pi/agent/settings.json` exists. Relevant fields: `defaultProvider: "anthropic"`, `defaultModel: "claude-fable-5"`, `defaultThinkingLevel: "medium"`, `packages: ["../../repos/pi-extensions"]`.
- `models-store.json`, `sessions/`, `trust.json` also present.

So the brief's "SDK adapter relies on credentials already on disk from TUI use" matches this environment. Whether those credentials are valid was **not** probed (would be a paid/live call).

#### Event stream shape (verified types)

`AgentEvent` (`pi-agent-core/dist/types.d.ts`):

- `agent_start` | `agent_end` | `turn_start` | `turn_end` | `message_start` | `message_update` | `message_end` | `tool_execution_start` | `tool_execution_update` | `tool_execution_end`

Streaming text is nested:

```
event.type === "message_update"
  && event.assistantMessageEvent.type === "text_delta"
  && event.assistantMessageEvent.delta  // string
```

`AssistantMessageEvent` also includes `start`, `text_start`/`text_end`, thinking and toolcall start/delta/end, `done`, `error`. Each `text_delta` carries `contentIndex`, `delta`, and a cumulative `partial` `AssistantMessage`.

`AgentSessionEvent` extends that union with session-level events: `agent_settled`, `queue_update`, `compaction_*`, `entry_appended`, `session_info_changed`, `thinking_level_changed`, `auto_retry_*`, `summarization_retry_*`, `bash_execution_update`.

RPC/JSON wire form (`dist/modes/json-event.d.ts`) **strips the cumulative `partial` snapshot** from `message_update` and keeps `usage` + the delta event. Comment on `toJsonEvent`: *"Remove cumulative assistant snapshots from streaming wire events. `message_start` provides the initial message, deltas build it, and `message_end` provides the final authoritative message."*

That is prior art for a thinner, serializable stream — relevant because Electron IPC and the agent port both need a cloneable event shape, and ADR 0001 forbids leaking SDK types into the renderer.

`@earendil-works/pi-coding-agent/client` exports `RemoteSession` plus `createTranscriptState` / `applyTranscriptProgress` / `selectTranscript`. Not opened beyond the `.d.ts` barrel. Possibly useful later for a chat model; unused today.

#### RPC mode as a sibling "prompt in, event stream out" surface

`docs/rpc.md`: JSONL over stdin/stdout. Command `{"type":"prompt","message":"..."}`; events stream asynchronously after acceptance; `success: true` means accepted/queued, not "the model finished". Docs explicitly tell Node/TypeScript users to prefer in-process `AgentSession` over spawning `pi --mode rpc`.

Not a candidate to copy as the app's architecture (brief already chose in-process SDK in main). Useful as an existence proof of a small command/event protocol that is not the SDK type surface.

---

### Electron / electron-vite prior art

Two different scaffolds exist under similar names. They are not the same toolchain.

#### A. `electron-vite` (alex8088) — matches the brief's named stack

- npm `electron-vite@5.0.0`. Homepage https://electron-vite.org. Peer: `vite: ^5 || ^6 || ^7`. Engines: `node: ^20.19.0 || >=22.12.0`.
- README: "Next generation Electron build tooling based on Vite." Scripts: `"dev": "electron-vite dev"`. Config file `electron.vite.config.js` with `main` / `preload` / `renderer` keys.
- Getting started points at `npm create @quick-start/electron@latest` and the `react-ts` playground.
- Recommended tree (`https://electron-vite.org/guide/dev`):

```
src/main/index.ts
src/preload/...
src/renderer/index.html + src/renderer/src/...
electron.vite.config.ts
```

Default entry discovery: `src/main/{index|main}.{js|ts}`, `src/preload/{index|preload}.{js|ts}`, `src/renderer/index.html`.

HMR (`/guide/hmr-and-hot-reloading`): renderer HMR requires loading `process.env.ELECTRON_RENDERER_URL` in dev vs `loadFile` in prod. Main/preload changes are **hot reloading** (rebuild + restart Electron), enabled by `electron-vite dev --watch`, not true HMR.

`electron-vite does not support nodeIntegration.` Quote from `/guide/dev`: *"We recommend using preload scripts and avoiding Node.js modules in the renderer."*

Sandbox + preload (`/guide/dev` § Limitations of Sandboxing, `/guide/troubleshooting`):

> From Electron 20 onwards, preload scripts are sandboxed by default and no longer have access to a full Node.js environment.

Options given by electron-vite docs: (1) set `sandbox: false`, or (2) fully bundle preload (isolated build / `externalizeDeps: false`) so the sandboxed preload is a single file.

Official `react-ts` playground (`packages/create-electron/playground/react-ts`) as of this fetch:

- `sandbox: false` is **set explicitly** in `src/main/index.ts` `webPreferences`. `contextIsolation` / `nodeIntegration` are left at Electron defaults (not spelled out).
- Preload exposes `@electron-toolkit/preload`'s full `electronAPI` (`ipcRenderer.send/invoke/on`, `webFrame`, `webUtils`, `process`) plus an empty `api` object.
- Renderer `App.tsx` calls `window.electron.ipcRenderer.send('ping')`.
- Scripts: `dev`, `start` (`electron-vite preview`), `lint`, `typecheck` (node + web projects), `build`. **No `test` script.** No test files in the playground listing.
- `.gitignore`: `node_modules`, `dist`, `out`, `.DS_Store`, `.eslintcache`, `*.log*`. No `logs/` directory convention.
- CSP in `index.html`: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:`.
- DevDeps pin `electron ^39.2.6`, `electron-vite ^5.0.0`, `react ^19.2.1`, `vite ^7.2.6`, ESLint 9 flat config via `@electron-toolkit/eslint-config-ts`.
- Also ships `electron-builder` scripts (`build:mac` etc.). Brief puts packaging out of scope.

#### B. `create-electron-vite` (electron-vite org) — different tool

- npm `create-electron-vite@0.7.1` → `npm create electron-vite@latest`.
- `electron/package.json` depends on `vite-plugin-electron` + `vite-plugin-electron-renderer`, **not** `electron-vite`.
- `template-react-ts` is a plain Vite+React 18 template (`"dev": "vite"`). Electron files live under `electron/main.ts` + `electron/preload.ts`.
- Preload exposes a near-raw `ipcRenderer` (`on`/`off`/`send`/`invoke`) on `window.ipcRenderer`, including the raw `event` object in `on`.
- `webPreferences` only sets `preload`. Relies on Electron defaults for sandbox / contextIsolation / nodeIntegration.

This scaffold does **not** match the brief's named "electron-vite" package. Recorded so it is not confused with (A).

#### Electron security defaults (primary docs, 2026-08-17 fetch)

From `docs/tutorial/security.md` checklist (items that collide with this milestone):

- 3. Enable context isolation — default since Electron 12.
- 4. Enable process sandboxing — default since Electron 20. *"Disabling context isolation also disables process sandboxing."*
- 2. Do not enable Node.js integration — default since Electron 5.
- 7. Define a CSP (`script-src 'self'`).
- 13–14. Disable or limit navigation and new-window creation (official template already `setWindowOpenHandler` → `shell.openExternal` + `deny`).
- 17. Validate the `sender` of all IPC messages.
- 20. Do not expose Electron APIs to untrusted web content.

`context-isolation.md` states context isolation is recommended for *all* applications and shows the **unsafe** pattern of exposing `ipcRenderer.send` wholesale, vs one method per channel via `contextBridge`.

`sandbox.md`: sandboxed renderer has no Node; sandboxed preload may `require` only `electron` (renderer modules), `events`, `timers`, `url`, plus `Buffer`/`process`/`setImmediate`. Multi-file CommonJS preload will not load; bundling is required if `sandbox: true`.

**Tension (fact, not a decision):** the brief's DoD says "renderer sandboxed (contextIsolation on, nodeIntegration off)". Electron 20+ defaults `sandbox: true`. The official electron-vite `react-ts` playground sets `sandbox: false`. electron-vite's own docs present `sandbox: false` as the easy fix for preload `module not found`. Keeping the brief's sandbox requirement means bundling preload (electron-vite isolated build / `externalizeDeps: false`), not copying the playground flag.

**Second tension:** both official scaffolds expose a broad `ipcRenderer` to the renderer. Electron's own IPC/contextIsolation docs call that unsafe. The brief asks for **typed IPC** and a renderer that never sees SDK types. The playground's `window.electron.ipcRenderer` is therefore prior art for *shape of a preload file*, not for the security posture this milestone stated.

#### IPC patterns that map onto "prompt in, event stream out"

From `docs/tutorial/ipc.md`:

- Pattern 2: `ipcRenderer.invoke` ↔ `ipcMain.handle` — two-way, Promise. Fits "send prompt". Errors thrown in `handle` serialize to `{ message }` only.
- Pattern 3: `webContents.send` ↔ `ipcRenderer.on` exposed as a **narrow** subscribe function. Fits "event stream out". Docs warn: do not pass the raw listener to `ipcRenderer.on` (leaks `event.sender`); wrap and forward only payload args. There is no `invoke` equivalent main→renderer.

A walking-skeleton chat therefore needs **both** patterns (or send + a correlated event channel). `session.prompt()` itself only resolves at end of turn; streaming cannot wait on that Promise alone.

Renderer console → main: `webContents` event `console-message` (`message`, `level` ∈ `info|warning|error|debug`, `lineNumber`, `sourceId`, `frame`). Also `preload-error`. This is a documented hook for DoD 6's "renderer errors/console forwarded into the same single chronological stream".

---

### Agent Browser (manual verification path, DoD 5)

Installed locally: `agent-browser 0.34.0` at `/Users/ike/.nvm/versions/node/v25.9.0/bin/agent-browser`. Skills available include `core` and `electron`.

Electron skill (verbatim workflow):

1. Launch the Electron app with `--remote-debugging-port=NNNN`.
2. `agent-browser connect NNNN`.
3. `snapshot -i` / click / fill / screenshot.

macOS example from the skill: `open -a "Slack" --args --remote-debugging-port=9222`. Flag must be present at launch; if the app is already running, quit and relaunch. After connect, `tab` lists windows/webviews.

Core skill: named sessions (`AGENT_BROWSER_SESSION` / `agent-browser session id --scope worktree`), snapshot refs go stale on re-render, prefer `wait --text` over bare sleeps, `find role/text/label` as fallback.

Legacy system skill `skills/agent-browser/SKILL.md` is a thin pointer at `agent-browser skills get core` and lists Electron as a specialized guide. Brief forbids copying files from the legacy system; the CLI's own skill text is the primary source.

**Gap:** nothing in this repo yet launches Electron with a CDP port. `npm run dev` (once it exists) will need a documented way to pass `--remote-debugging-port` or the equivalent Chromium switch, or agents cannot perform DoD 5. How that is wired is not decided here.

---

### Testing prior art (fast unit + component, no browser E2E)

Brief (Q6): unit tests for main-process logic and adapters; component tests for the chat pane against the fake adapter; "anything that's very fast"; no Playwright/Cypress-style E2E suite.

Current npm versions (2026-08-17):

| Package | Version | Notes |
| --- | --- | --- |
| `vitest` | 4.1.10 | Peer vite `^6 \|\| ^7 \|\| ^8`. Optional `jsdom` / `happy-dom`. π SDK itself uses vitest (`package.json` `"test": "vitest --run"`). |
| `@testing-library/react` | 16.3.2 | Peer React 18 or 19; needs `@testing-library/dom ^10`. |
| `jsdom` | 30.0.1 | Common vitest `environment: 'jsdom'`. |
| `happy-dom` | 20.11.2 | Faster alternative environment. |
| `@playwright/experimental-ct-react` | 1.62.1 | Component tests in a real browser. Brief called browser E2E "complete overkill"; whether CT-in-browser counts as that is **UNVERIFIED** / open. |

Official electron-vite `react-ts` playground has **no test runner**. Any test stack is additive.

Component tests "against the fake adapter" only stay fast if the chat pane can be mounted **without Electron** — i.e. the pane depends on an agent-port-shaped object, not on `window.electron` or IPC. That placement is a seam (below), not a decision.

---

### Logging prior art

Brief wants: one merged chronological **JSONL** stream, repo-local, gitignored (example `logs/`), covering main lifecycle, every agent-port call/event (adapter identity, prompt, stream events, errors), IPC failures, and renderer console/errors. Bar: an agent can diagnose from the log file alone.

`electron-log@5.4.4`:

- Default file locations are **OS log dirs** (`~/Library/Logs/{app name}/main.log` on macOS), not a repo-local `logs/`.
- Default file format is **not JSONL**: `'[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}'`.
- Has IPC transport so renderer `import log from 'electron-log/renderer'` can reach the main file transport.
- Path is overridable via `log.transports.file.resolvePathFn`.
- Does not, out of the box, match "one JSONL file in `logs/`". Could be bent; is not a drop-in.

`pino@10.3.1`: "super fast, all natural json logger" — JSON lines to a stream. No Electron renderer bridge of its own.

Electron built-in: `webContents.on('console-message')` for renderer console; main can write its own lines. Unhandled renderer errors also show up as console messages if not swallowed.

Official playground `.gitignore` `*.log*` would ignore `foo.log` but **not** `logs/app.jsonl`. A `logs/` ignore rule is not present anywhere in this repo (there is no `.gitignore` yet).

No logging implementation exists here.

---

### Legacy system (reference only; copy nothing)

Path: `/Users/ike/repos/pi-extensions`. TUI extension workspace + Crucible workflow engine. `package.json` name `ike-pi-extensions`, `"type": "module"`, scripts `typecheck` / `test` (`node --test`) / `validate`. No Electron, no React, no agent port.

Surfaces in *its* `CONTEXT.md` (TUI, Dashboard, Context area, …) are that repo's language. This repo's `CONTEXT.md` is a different glossary. Do not import those surface names unless `/align` writes them here.

`docs/adr/` there is about workflow/doctrine, not UI/SDK. `extensions/cmux-dashboard/` is HTML+TS served inside π, not a desktop app.

Agent Browser skill lives there; the installed CLI skill text was used instead of copying that file.

`.gitignore` in the legacy system ignores `node_modules/`, `.firecrawl/`, `.crucible/`. Not copied.

---

### Environment facts that affect the tracer-bullet SDK adapter

- Local Node `v25.9.0` satisfies both `electron-vite` (`>=22.12.0`) and the SDK (`>=22.19.0`).
- `pi` 0.84.2 and the Homebrew package 0.84.2 match.
- Disk credentials exist for three providers. Validity **UNVERIFIED** (not contacted).
- Importing the SDK from this repo fails until it is a declared dependency.
- "Proven against the real SDK once" is a one-shot, costed call. It is not a test that agents should run. Fake adapter remains the default.

---

### Candidate seams

Feathers' sense (enabling-point language; verbatim book quote **UNVERIFIED** — primary text not fetched): a **seam** is a place you can change behaviour without editing the call site; the **enabling point** is where you choose which behaviour runs.

These are places new behaviour could attach. They are not a chosen design.

#### Seam 1 — Agent port (already decided to exist)

- **Call site that should not change:** anything UI-side that sends a prompt or renders a stream.
- **Behaviour behind the seam:** fake adapter (canned stream) vs SDK adapter (`createAgentSession` + `prompt`/`subscribe`).
- **Enabling point (open):** who constructs the adapter and when. Brief says fake is the dev/test default; SDK adapter is included and proven once.
- **Why it is a seam:** ADR 0001 bought this indirection so UI tests never touch π types and the SDK can be left later.
- **Type surface constraint:** the port's events cannot be `AgentSessionEvent` / `AssistantMessageEvent` if the renderer imports them. A Crucible-owned prompt-in / event-stream-out shape has to live on this side of the seam. RPC's `JsonAgentSessionEvent` (deltas without `partial`) is prior art for a thin wire event, not a type to reuse in the renderer.

#### Seam 2 — Renderer-side port handle (chat pane dependency)

- **Call site:** the walking-skeleton chat pane (type a message, render streamed text).
- **Behaviour behind the seam:** an in-process fake adapter vs an IPC client that talks to main.
- **Enabling point (open):** constructor / props / context that gives the pane "something that looks like the agent port".
- **Why it is a seam:** DoD 4 wants component tests of the chat pane against the fake adapter, and Q6 wants those tests "very fast" with no browser E2E. That is only possible if the pane does not import Electron or `window.electron`. Official playgrounds bind the UI to `window.electron.ipcRenderer` / `window.ipcRenderer` — that would pin tests to Electron or force JSDOM stubs of IPC, which is the rejected "mock the foreign surface" shape.
- **Stacked with seam 1:** either the fake adapter is injected directly into the pane (tests + maybe dev), or the pane always uses an IPC client and the fake lives only in main (then component tests need a second, renderer-local fake of the *client*). Both are compatible with ADR 0001; they are different enabling points.

#### Seam 3 — Main-process adapter selection (composition root)

- **Call site:** IPC handlers that implement "prompt" and "subscribe to events".
- **Behaviour behind the seam:** which agent-port implementation those handlers call.
- **Enabling point (open):** env var, CLI flag, or a factory invoked at `app.whenReady`. Brief: fake is default "everywhere agents operate"; human prototyping with the real SDK is allowed later (Q7).
- **Why it is a seam:** DoD 5 (Agent Browser, "Hello agent", canned reply, zero API cost) and the one-shot real-SDK proof need to flip implementations without editing handlers or the pane. This is also where logging can record `which adapter`.

#### Seam 4 — Log sink (single chronological JSONL stream)

- **Call site:** main lifecycle, agent-port wrappers, IPC error paths, renderer-console forwarder (`webContents` `console-message` / `preload-error`).
- **Behaviour behind the seam:** write a line to a file under e.g. `logs/` vs capture lines in memory.
- **Enabling point (open):** a writer object the rest of the app calls (`append(record)`), constructed once at startup.
- **Why it is a seam:** DoD 6 requires one meaningful test that renderer→log forwarding works. That test is only fast and deterministic if the sink is replaceable (temp file or in-memory buffer) instead of a hard-coded `~/Library/Logs/...` or an un-injected `fs.appendFile` at each call site. `electron-log` and `pino` are libraries that could sit behind this seam; neither matches the brief's "repo-local JSONL" defaults without configuration.

Not listed as seams (no behaviour to swap for this milestone): BrowserWindow construction itself, Vite config, ESLint. Those are scaffolding, not Feathers seams.

---

### Open uncertainties

1. **Where the fake adapter is constructed relative to the process boundary.** In-renderer (seam 2 enabling point A) vs only-in-main (seam 2 enabling point B). Determines how component tests mount the chat pane. Brief + ADR are compatible with both; they do not pick.

2. **Agent-port event vocabulary.** How thin is "event stream out" for milestone 1? Walking skeleton only needs something like "user accepted / text delta / turn ended / error". The SDK emits a large union including tools, compaction, retries. Port types must not be SDK types. Mapping and how much to discard is undecided.

3. **IPC channel shape.** `invoke('prompt')` that resolves when `session.prompt()` resolves, plus a main→renderer event channel? Or a single streaming protocol? Electron has no built-in invoke-for-streams. Correlation ids, abort, and what happens if the renderer calls prompt while already streaming (`streamingBehavior` required) are unspecified. Milestone 1 is chat-only and unstyled; abort/steer may be skippable — **not settled**.

4. **`sandbox: true` vs official template `sandbox: false`.** Brief says sandboxed renderer. Playground and electron-vite troubleshooting push `sandbox: false`. Keeping `sandbox: true` implies bundling preload as one file (electron-vite isolated build). Not decided; recorded as a constraint-vs-prior-art clash.

5. **How agents pass `--remote-debugging-port` into `npm run dev`.** Required for DoD 5. electron-vite's way of forwarding Chromium flags was not verified (`electron-vite dev -- --remote-debugging-port=9222` is **UNVERIFIED**).

6. **One-shot SDK proof: what "proven once" means operationally.** Manual `npm` script with the SDK adapter? A test that is skipped unless a human sets an env var? Out of the default `npm test` either way (paid call). Credentials exist; whether `createAgentSession()` + `prompt("...")` succeeds on this machine was not tried.

7. **Log file path and rotation.** Brief example is `logs/`. Single file vs dated files, process vs run identity in each JSONL record, and whether `*.log*` gitignore is enough (it is not, for `.jsonl`) are open.

8. **Test runner choice.** Vitest matches the SDK's own tests and Vite. `@testing-library/react` + jsdom/happy-dom matches "fast component tests". Playwright CT is a real browser and may violate Q6's spirit. Nothing in-repo picks.

9. **Which scaffolder to start from.** `npm create @quick-start/electron` (electron-vite, React 19, toolkit, `sandbox: false`, electron-builder) vs hand-rolling `electron-vite` + React to avoid packaging and the broad IPC exposure. `create-electron-vite` is the wrong package name for the brief. Q9 forbids copying legacy files; it does not forbid using an upstream template.

10. **SDK adapter options for "chat only".** `noTools: "all"`, `SessionManager.inMemory()`, `SettingsManager.inMemory()`, custom `cwd`/`agentDir` vs inheriting `~/.pi/agent`. Using the user's real `auth.json` is implied by Q12. Whether the adapter should also load the user's extensions/skills (`packages: ["../../repos/pi-extensions"]` in settings) would pull the legacy system into a runtime session — that conflicts with "nothing here depends on it at runtime" if interpreted strictly. **UNVERIFIED** whether `ModelRuntime.create()` / `createAgentSession()` with default `agentDir` would load those packages.

11. **Git.** This directory is not a repository. Whether scaffolding should `git init` is outside research.

12. **`.firecrawl/` files.** Present, unexplained by the brief. Ignore unless a later align says otherwise.

---

### Claims marked UNVERIFIED

- Verbatim Feathers wording and page cite (book not fetched).
- `electron-vite dev -- --remote-debugging-port=9222` (or equivalent) actually reaches Chromium.
- Validity of `~/.pi/agent/auth.json` credentials; whether a live `session.prompt` would succeed.
- Whether default `createAgentSession()` on this machine would load `pi-extensions` via `settings.json` `packages`.
- Whether Playwright component testing is considered "browser E2E" under Q6.
- GitHub API tree listings that failed to parse; not used as evidence.
- Contents of `@earendil-works/pi-coding-agent/client` beyond the type barrel (RemoteSession / transcript helpers exist; behaviour unread).
- electron-log JSONL capability beyond "format can be a function" (not tried).
