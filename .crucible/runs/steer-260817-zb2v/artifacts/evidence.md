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

---

## 2026-08-17 — draft pass (steering document)

Re-verified in `/Users/ike/repos/crucible` before writing the steering document.
Nothing new was researched here; these are checks that the seam sketch's
executed decisions and the "no application code yet" baseline still hold.

Commands and results:

- `git log --oneline -n 5` → `fe2e47c Seam sketch for the Electron boilerplate
  milestone`, `fe55b08 Align residue and steer run for the Electron boilerplate
  milestone`. Both dated 2026-08-17 (`git log --format='%H %ad %s' --date=short`).
- `git remote -v` → `origin https://github.com/secondcircle/crucible.git`
  (fetch and push).
- `gh repo view secondcircle/crucible --json name,visibility,defaultBranchRef`
  → `{"defaultBranchRef":{"name":"main"},"name":"crucible","visibility":"PRIVATE"}`.
- `cat .gitignore` → `node_modules/`, `out/`, `dist/`, `logs/`, `.DS_Store`,
  `.firecrawl/`. The `logs/` line DoD 6 depends on is present.
- `ls -a` → `.crucible`, `.firecrawl`, `.git`, `.gitignore`, `AGENTS.md`,
  `CONTEXT.md`, `docs`. `ls package.json` → `No such file or directory`.
  Still no application code, no `src/`, no lockfile, no `node_modules/`.

Implication for the steering document: the version-control decision is done,
not pending; build order starts at the scaffold, and every application file is
still new.

Tooling note: the format's mechanical lint was run against the draft with
`node --experimental-strip-types` importing `lintSteeringDoc` from
`/Users/ike/repos/pi-extensions/crucible/workflows/steer.ts`; final run
reported no problems (Zone A 197 nonblank lines, 2205 words).

---

## 2026-08-17 — revision pass (fact audit + cold read)

### What the two reviews changed in the steering document

Both blocking findings were accepted and fixed in place; no finding was refuted.

1. **`## Not doing` contradicted its own preamble** (fact audit, blocking 1). The
   bullets "Abort, steer, follow-up while streaming — refused instead (D6)" and
   "Tool calls, thinking, compaction, retries — dropped by the mapping (D3)"
   both described active runtime behaviour inside a section whose first line
   says nothing refuses anything at runtime. Both bullets are gone. A single
   line after the fence list now points at the Decision that does the refusing
   (D6), which is the promotion path the format allows; the dropped SDK events
   are stated in D3's own text, so no fence entry is needed for them.
2. **Zone B invented empty-prompt validation and stamped it "D6"** (fact audit,
   blocking 2). The row now records the truthful default — no validation layer
   exists this milestone, an empty prompt is admitted like any other and gets a
   turn and a terminal event — and cites D3, whose text establishes exactly that
   rule. No new decision is introduced anywhere in Zone B as a result.
3. **`(Contracts)` pointers that pointed nowhere** (minor 3). Rather than
   downgrade the pointers to "(Shape)", Contracts now actually carries
   `createSdkAdapter`'s construction and `toPortEvent`'s mapping table, which is
   where a builder would look for them anyway.
4. **`warn` record on an unrecognized `CRUCIBLE_AGENT`** (minor 5). The
   unstated log level is gone; D5's own text now settles unrecognized values
   ("unset or unrecognized means fake") and the row only says the ignored value
   reaches the log.
5. **`console-message` field name** (minor 6). "level and source" replaced with
   the primary doc's actual parameters: `message`, `level`, `lineNumber`,
   `sourceId`, `frame`.

Cold-read divergences, all settled by naming one build in Zone A and
elaborating it in Zone B: event cardinality (started → deltas → exactly one
terminal, immediate failures included) in D3; busy-send behaviour (the pane
disables send; the guard is for races and non-UI callers) in D6 and the chat
pane's Shape entry; fixed debugging port 9222 and unrecognized-value fallback
in D5; reload ends the turn and releases the guard in the agent channel's Shape
entry; explicit provider/model in D11; one log file per launch in D9. Zone A
stayed inside budget (197 nonblank lines, 2200 words) by trimming prose
elsewhere, not by demoting any of these.

The cold read's twelve unanswerables are answered in Zone B (Contracts and the
behaviour table): turn-id ownership per seam, error payload and redaction,
subscription guarantees, refusal and guard release, disposal on reload/close/
quit, log durability, forwarded console levels, debug-port binding, malformed
input handling, the fence's transitive argument, `prove:sdk`'s pass criterion,
and the Agent Browser recipe.

### New verification done for this pass

The revision added a Contracts snippet for `createSdkAdapter`; the first draft
of that snippet guessed the SDK's option names (`sessions:` / `settings:`), so
the real surface was read before publishing it.

Read: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.d.ts`,
`dist/core/settings-manager.d.ts`, `dist/core/session-manager.d.ts`,
`node_modules/@earendil-works/pi-ai/dist/compat.d.ts`,
`node_modules/@earendil-works/pi-ai/dist/providers/all.d.ts`.

- `CreateAgentSessionOptions` fields, verbatim from `sdk.d.ts`: `cwd`,
  `agentDir`, `modelRuntime`, `model`, `thinkingLevel`, `scopedModels`,
  `noTools` (`"all" | "builtin"`), `tools`, `excludeTools`, `customTools`,
  `resourceLoader`, `sessionManager`, `settingsManager`, `sessionStartEvent`.
  The guessed `sessions` / `settings` keys do not exist.
- Documented defaults, verbatim: `agentDir` "Default: ~/.pi/agent";
  `sessionManager` "Default: SessionManager.create(cwd)"; `settingsManager`
  "Default: SettingsManager.create(cwd, agentDir)"; `modelRuntime` "Defaults to
  a runtime using agentDir/auth.json and models.json".
  This is the mechanical basis for D11: passing `SettingsManager.inMemory()`
  replaces the manager that would read `~/.pi/agent/settings.json`, while
  leaving `agentDir` default keeps auth resolution — credentials in, settings
  (and their `packages: ["../../repos/pi-extensions"]`) out.
- `SettingsManager.inMemory(settings?: Partial<Settings>, options?)` and
  `SessionManager.inMemory(cwd?, options?)` both exist as statics.
- `getModel` is exported from `@earendil-works/pi-ai/compat` and is marked
  `@deprecated`: "Use `getBuiltinModel` from
  '@earendil-works/pi-ai/providers/all' or `Models.getModel()`".
  `getBuiltinModel(provider, modelId)` is declared in `dist/providers/all.d.ts`.
- `claude-fable-5` is present in the built-in anthropic catalog:
  `node -e "Object.keys(require('./dist/providers/data/anthropic.json')['anthropic-messages'])"`
  → `claude-fable-5`, `claude-haiku-4-5`, `claude-opus-4-5`, `claude-opus-4-6`,
  `claude-opus-4-7`, … So the pinned constant names a model the catalog knows;
  whether the on-disk credentials may call it is still what `prove:sdk` settles.

Lint after revision: `lintSteeringDoc` reports no problems; Zone A 197 nonblank
lines, 2200 words.

---

## 2026-08-17 — revision pass 2 (fact-audit-2 + cold-read-2)

Both blocking findings accepted and fixed; no finding refuted. Four of the five
minor findings fixed; one (M3, "HMR") fixed by a route the auditor did not
propose, described below.

### Blocking

**B1 — Contracts decided a log schema Zone A calls open.** Accepted: the
example record carried nine fields and a closed `source` enum (including
`agent-port`, used nowhere else) under a heading citing D8/D9, while "Where to
push back" and A6 say only timestamp, sequence, source and turn id are settled.
Fixed by shrinking the fenced record to exactly those four fields, deleting the
`agent-port` enum value, and replacing the rest with what D8 *does* decide —
that each record must convey adapter identity, prompt, event and error — while
stating outright that field names, levels and nesting are the implementer's,
bounded by two constraints (single-line JSON; nothing needing a second writer).
The `source` field keeps a stated obligation rather than an enum: it must
distinguish `main` from `renderer`, because D9's forwarding claim is otherwise
uncheckable.

**B2 — "the switch binds loopback only" was uncited.** Accepted, and checked
rather than reworded away. Fetched
`https://raw.githubusercontent.com/electron/electron/main/docs/api/command-line-switches.md`
(HTTP 200, 2026-08-17):

- `### --remote-debugging-port=`port`` — "Enables remote debugging over HTTP on
  the specified `port`." That is the entire entry; there is no statement about
  bind address.
- `grep -c "remote-debugging-address" cls.md` → `0`. Electron documents no
  companion address switch, so my draft's implied "and we can pin it if not"
  would also have been unfounded.
- The file's opening example is
  `app.commandLine.appendSwitch('remote-debugging-port', '8315')` before the
  `ready` event — which independently confirms the A1 fallback the build order
  already carried.

So the claim is now carried as what it is: an UNVERIFIED row with a one-shot
check (`lsof -nP -iTCP:9222 -sTCP:LISTEN` while the app runs), a Contracts
sentence saying Electron documents no address switch and that off-loopback
binding is a finding to fix, and a check in build-order slice 1.

### Minor

- **M1 (size self-report).** Correct and my error: I counted Zone A with an
  `awk` that stops *before* the cut line, while `splitZones` includes it. The
  document now reports what the format's own tool measures ("199 lines, as the
  format's lint counts them"), and this pass reports tool numbers only: Zone A
  199 nonblank lines, 2258 words; Zone B 303.
- **M2 (flag spelling).** Fixed: `--remote-debugging-port=9222` everywhere.
- **M3 (HMR untraced).** Accepted as a real contract gap, but not by deleting
  the word: HMR is DoD 1 in the intent brief, so the honest fix is to give it a
  Decision and a choke point. D2 now reads "renderer loaded from electron-vite's
  dev URL so edits hot-reload", and its `*Enforced:*` line names
  `createMainWindow` — its `webPreferences` *and* its dev-URL load — which is
  literally the one function where both the sandbox flags and the dev-vs-file
  load are decided (evidence, "Electron / electron-vite prior art":
  `ELECTRON_RENDERER_URL` in dev vs `loadFile` in prod). Slice 1 now closes on a
  hot-reload check.
- **M4 (malformed IPC row).** Fixed: the row no longer invents type validation
  or payload-shape logging; it states the same no-throw-across-IPC shape D6
  already establishes for the handler.
- **M5 (second-window row tagged D6).** Fixed: retagged D2, and the row now
  says what D2 makes true — `createMainWindow` is the only `BrowserWindow`, so
  single-flight is app-global by construction. That also answers the cold
  read's "per window, per session, or global?".

### Cold-read divergences, all settled in Zone A

- *Tools/compaction/retries*: D3 now separates the two builds explicitly —
  tool, compaction and retry **events** are dropped by the mapping; **tools**
  are off at the session (D11); compaction and retries remain the SDK's own
  business rather than something Crucible disables.
- *Event-before-promise ordering*: the agent port's interface prose now states
  that a turn's events can begin before the prompt call resolves, so callers
  subscribe first — Build B, matching what Contracts already required.
- *Reload cancels or detaches*: the agent channel's interface prose now says a
  reload disposes the adapter's session, so the underlying work stops rather
  than running on unseen.
- *Where single-flight lives*: the port's interface prose now says whoever
  answers a prompt mints its turn id, and single-flight lives in exactly one
  place — main's handler — while an adapter driven straight from a test serves
  whatever it is asked.

Cold-read unanswerables that were genuinely missing are now in Zone B: the fake
adapter's script/cadence contract (exported constants, pause as a constructor
parameter, zero in tests), log privacy and retention (verbatim prompts, no
redaction, no rotation, repo-local and gitignored, revisit before logs leave the
machine), pre-prompt failure (a session that cannot be created fails the first
prompt as a terminal `error`), and partial-output-then-failure (deltas stand,
the error line goes under them). The remainder were already answered in Zone B,
which the cold reader does not see by design.

Zone A stayed inside budget by trimming prose in The bet, Shape and Done looks
like — no settled decision was demoted to get there. Lint: CLEAN.

---

## 2026-08-17 — final fix-only pass (fact-audit-3)

Four blocking findings, all four accepted; none refuted. Zone A did not grow
(199 nonblank lines before and after, 2272 words), nothing was restructured,
and no minor finding was chased.

**B1 — empty-prompt row tagged D3.** The auditor is right and my previous
evidence note was wrong: I wrote that D3's text "establishes exactly that rule",
but D3 decides the four-event vocabulary and what `toPortEvent` drops, and says
nothing about whether a prompt is admitted. The row asserted an invariant ("no
validation layer exists… it is admitted like any other prompt") with no Decision
to classify it, which is the same leakage the first audit caught, in a quieter
form. Fixing it properly would mean a new Decision, and a fix-only pass may not
grow Zone A — so the row now asserts nothing: it records that no Decision
governs empty prompts, tells slice 3 to pick one and keep it in one place, and
carries `none` in the Decision column instead of a borrowed tag. That leaves the
gap visible to the human rather than papered over with a wrong citation.

**B2 — session disposal on reload/close/quit tagged D6.** Accepted. Four sites
(Shape's agent channel, Contracts' SDK adapter, two behaviour rows) asserted
that a window reload, close or quit disposes the live session and releases the
guard — a real commitment about whether a paid request is torn down — while D6's
text covered only refusal and correlation. D6's body now carries it: "…reload,
close or quit disposes that session and frees the guard." Its `*Enforced:*` line
is unchanged and still correct: the single-flight guard in main's `agent:prompt`
handler is the one place a turn's lifetime — acquisition and release — is
decided. The body was tightened elsewhere so the entry stayed three lines.

**B3 — log failure policy tagged D9.** Accepted. "Records are dropped, not
buffered" and "`append` writes synchronously" are engineering commitments
(blocking I/O per call; accepted data loss on write failure) that D9's text did
not contain. D9's body now reads "…writing one file per launch under `logs/`,
appending synchronously and dropping any record it cannot write", so both rows
trace to the Decision that classifies them, and the reviewer sees the trade-off
where reviewers look.

**B4 — preload `require` whitelist.** Accepted, and it was a plain error of
mine: Contracts said "no `require` of anything outside `electron`" while Facts
on file in the same document correctly reports Electron's sandbox whitelist.
Re-checked against evidence.md's "Electron / electron-vite prior art" section,
which records from `docs/tutorial/sandbox.md` that a sandboxed preload may
`require` `electron`, `events`, `timers`, `url` (plus `Buffer`, `process`,
`setImmediate`). Contracts now states that whitelist and points at Facts on
file, so the two sections agree.

Lint after this pass: CLEAN. Zone A 199 nonblank lines, 2272 words; Zone B 304.

---

## 2026-08-17 — slice 1 (scaffold and dev loop) verification

All of the below was run on this machine against the scaffold committed by
slice 1 (`build-260817-eke1`), Node v25.9.0, electron 43.4.0,
electron-vite 5.0.0, vite 7.3.6, agent-browser 0.34.0.

### A1 settled: `electron-vite dev` does forward the switch

`electron-vite@5.0.0` has a `--remoteDebuggingPort <port>` CLI option:
`dist/cli.js` sets `process.env.REMOTE_DEBUGGING_PORT`, and `startElectron`
(`dist/chunks/lib-q6ns0vZr.js:226`) pushes
`--remote-debugging-port=${process.env.REMOTE_DEBUGGING_PORT}` onto the Electron
argv when `NODE_ENV_ELECTRON_VITE === 'development'`. So the `dev` script is
`electron-vite dev --remoteDebuggingPort=9222` and **main sets no switch of its
own** — A1's fallback (`app.commandLine.appendSwitch` under a dev guard) is not
needed and was not implemented.

Observed at launch, stdout of `npm run dev`:

```
starting electron app...

DevTools listening on ws://127.0.0.1:9222/devtools/browser/2f1ceae7-…
```

Process argv (`ps`): `…/Electron.app/Contents/MacOS/Electron . --remote-debugging-port=9222`.

### Agent Browser attaches

```
$ agent-browser connect 9222
[agent-browser] launched browser
✓ Done
$ agent-browser snapshot
- generic [ref=e1] clickable [onclick]
  - main
    - heading "Crucible" [level=1, ref=e2]
    - paragraph
      - StaticText "Scaffold running."
```

### The port binds loopback

```
$ lsof -nP -iTCP:9222 -sTCP:LISTEN
COMMAND    PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
Electron 57595  ike   31u  IPv4 0x69f6c9e56c85a546      0t0  TCP 127.0.0.1:9222 (LISTEN)
```

Loopback only, as guessed — not `*:9222`. Cross-checked over HTTP:
`curl http://127.0.0.1:9222/json/version` → 200; the same request to this
machine's LAN address (`192.168.1.148:9222`) fails to connect. No finding to
fix.

### A launch against an already-busy 9222

Second `npm run dev` while the first app still held the port. The renderer dev
server moves aside on its own (`Port 5173 is in use, trying another one…` →
5174), the **second app still opens a window**, and Chromium logs:

```
[57977:0817/121132.294006:ERROR:net/socket/socket_posix.cc:175] bind() failed: Address already in use (48)
[57977:0817/121132.294029:ERROR:content/browser/devtools/devtools_http_handler.cc:311] Cannot start http server for devtools.
```

Electron does **not** fall back to another port and does not exit: the second
launch is simply undebuggable. The hazard the steering document named is real —
`agent-browser connect 9222` then attaches to whichever app got there first,
with nothing in its output saying so:

```
$ agent-browser connect 9222 && agent-browser eval "location.href"
"http://localhost:5173/"        # the FIRST app; the second is on 5174
$ curl -s http://127.0.0.1:9222/json/list | grep '"url"'
   "url": "http://localhost:5173/",
```

Operational rule, now in `AGENTS.md`: quit the stale launch before connecting.

### Sandbox, context isolation, no node integration (D2)

`createMainWindow` sets `sandbox: true`, `contextIsolation: true`,
`nodeIntegration: false`. Observed at runtime rather than only in source:

- the renderer child process carries Chromium's `--enable-sandbox`:
  `Electron Helper (Renderer) --type=renderer --user-data-dir=…/crucible --app-path=/Users/ike/repos/crucible --enable-sandbox --remote-debugging-port=9222 …`
- in the renderer, `agent-browser eval` reports
  `{"require":"undefined","process":"undefined","module":"undefined","crucible":"undefined","url":"http://localhost:5173/"}`
  — no Node globals, and nothing exposed on `window` yet (D7 is slice 5).

### A5 settled: a bundled preload loads under `sandbox: true`

The preload config omits `externalizeDepsPlugin` and forces `format: 'cjs'`, so
electron-vite emits one file, `out/preload/index.js` (0.06 kB). It loads:
`agent-browser console` after a reload shows

```
[info] [crucible] preload loaded
[debug] [vite] connecting...
[debug] [vite] connected.
```

Note on the Contracts snippet: it names the preload `../preload/index.mjs`.
This scaffold keeps `package.json` CommonJS (no `"type": "module"`), so
electron-vite emits one CJS bundle named `index.js` and the window points at
`../preload/index.js` — verified above to load under `sandbox: true`. Same
fact, different extension.

### HMR through `ELECTRON_RENDERER_URL`

With the app running, editing `src/renderer/src/App.tsx` (`Scaffold running.` →
`Scaffold running — hmr probe.`) updated the live window within seconds:
`agent-browser get text body` returned the new text, and the console shows
`[vite] hot updated: /src/App.tsx` with **no** second `[crucible] preload loaded`
line — a hot update, not a reload. The edit was reverted.

### Toolchain notes

- `npm run lint`, `npm run typecheck` (node + web projects) and `npm test`
  (vitest 4.1.10, jsdom, one component test) are all green.
- Electron 43.4.0 ships **no `postinstall`**; it exposes an `install-electron`
  bin instead, so `npm install` alone leaves `node_modules/electron/dist`
  missing and `electron-vite dev` dies with `Error: Electron uninstall`. The
  repo's `package.json` therefore carries `"postinstall": "install-electron"`,
  verified to fetch the binary on `npm install`.
- `jsdom@30.0.1` declares `node: ^22.22.2 || ^24.15.0 || >=26.0.0`, so npm warns
  EBADENGINE on this machine's Node v25.9.0. It is a warning only: the jsdom
  component test runs and passes.
- Registry facts differ from the versions quoted in the earlier passes:
  latest `eslint` is 10.8.1, `typescript` 7.0.2 (typescript-eslint 8.67 caps at
  `<6.1.0`, so TypeScript is pinned to ^5.9.3), and `@vitejs/plugin-react@6`
  requires vite ^8 while electron-vite 5 peers vite ^5–^7 — hence
  `@vitejs/plugin-react@^5.2.0`.

## 2026-08-18 — slice 7 (SDK adapter and the proof) verification

Run on this machine against the adapter committed by slice 7
(`build-260817-8q9i`), Node v25.9.0, electron 43.4.0,
`@earendil-works/pi-coding-agent@0.84.2`, `@earendil-works/pi-ai@0.84.2`.

### A2 settled, and not the way it was guessed: the pinned model could not answer

The on-disk credentials are **valid** — `~/.pi/agent/auth.json` holds live
OAuth entries for `anthropic`, `openai-codex` and `xai`, and the request reaches
Anthropic — but a bare `createAgentSession` against Anthropic draws on the
extra-usage pool rather than the subscription, and that pool is empty. Every
Anthropic model answers the same 400, so it is not a model-tier problem:

```
anthropic claude-fable-5   -> error 400 {"type":"error","error":{"type":"invalid_request_error",
    "message":"You're out of extra usage. Add more at claude.ai/settings/usage and keep going."},
    "request_id":"req_011CeAV1UmHy2dgWny5Qq66M"}
  text: ""
anthropic claude-haiku-4-5 -> error 400 {… "You're out of extra usage. …"}
  text: ""
openai-codex gpt-5.4-mini  -> stop
  text: "Hello from the Crucible agent."
xai grok-4.5               -> stop
  text: "Hello there, friend — welcome aboard!"
```

Subscription usage is only drawn when the product name `pi` is rewritten to the
π symbol in the system prompt — the legacy system's `anthropic-pi-symbol`
extension. That behaviour is deliberately **not** ported in this slice. Human
ruling on the deviation report: repin `SDK_MODEL` to `openai-codex` /
`gpt-5.4-mini`, one constant, and carry the rename as a named follow-up.

### `assistantMessageEvent.error` is unreachable in this SDK version

`message_update` is emitted in exactly one place —
`pi-agent-core/dist/agent-loop.js:222` — and only for the streaming *content*
variants (`text_*`, `thinking_*`, `toolcall_*`, lines 210-226). `case "done":`
and `case "error":` (line 228) both fold the outcome into the final message and
emit `message_end` instead, and `prompt()` resolves normally. Raw session events
for the failing request above:

```
EVENT {"type":"agent_start"}
EVENT {"type":"turn_start"}
EVENT {"type":"message_start"}   # the user message
EVENT {"type":"message_end"}     # the user message
EVENT {"type":"message_start"}
EVENT {"type":"message_end", message:{… "stopReason":"error",
        "errorMessage":"400 {…\"You're out of extra usage.…\"}"}}
EVENT {"type":"turn_end"}
EVENT {"type":"agent_end"}
```

So D3's mapping table gained one row (human-approved): `message_end` whose
assistant message has `stopReason: "error"` maps to `error` with code
`adapter`. Without it a paid failure reached the pane as a clean `turn_ended`
with no text. Verified end to end by pointing `SDK_MODEL` at the exhausted
Anthropic pair for one run — `turn_started`, then the error, and **no**
trailing `turn_ended`, because the first terminal event closes the turn:

```
[t-1] turn_started
[t-1] error (adapter) 400 {"type":"error","error":{"type":"invalid_request_error",
      "message":"You're out of extra usage. Add more at claude.ai/settings/usage and keep going."},
      "request_id":"req_011CeAVj2oGAp1v4bbBEcrEr"}
FAIL — the turn failed: …
```

The constant was put back to `openai-codex` / `gpt-5.4-mini` immediately after.

### `npm run prove:sdk` — the one-shot proof (D12), stdout verbatim

```
> crucible@0.0.0 prove:sdk
> CRUCIBLE_AGENT=sdk node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/prove-sdk.ts

prove:sdk — Crucible SDK adapter against the real π SDK
date:   2026-08-18T16:02:43.950Z
model:  openai-codex/gpt-5.4-mini
node:   v25.9.0
prompt: "Say hello in five words."

prompt accepted as t-1
[t-1] turn_started
[t-1] text_delta "Hello"
[t-1] text_delta " from"
[t-1] text_delta " me"
[t-1] text_delta ","
[t-1] text_delta " right"
[t-1] text_delta " now"
[t-1] text_delta "."
[t-1] turn_ended

reply:  "Hello from me, right now."
PASS — turn_started, 7 text_delta, turn_ended
```

Exit code 0, one turn, tools off, well inside the 60s deadline. The model pair
actually proved is **`openai-codex/gpt-5.4-mini`**, not the
`anthropic/claude-fable-5` the steering document named.

### `npm run dev:sdk` — the same pane on the real SDK

`CRUCIBLE_AGENT=sdk npm run dev`, then the DoD 5 recipe against the real
adapter. Agent Browser after "Say hello in five words." was sent through the
pane:

```
- generic [ref=e1] clickable [onclick]
  - main
    - heading "Crucible" [level=1, ref=e2]
    - list "Transcript"
      - listitem "You" [level=1, ref=e3]
        - StaticText "Say hello in five words."
      - listitem "Agent" [level=1, ref=e4]
        - StaticText "Hello from the coding assistant."
    - form
      - textbox "Message" [ref=e5]
      - button "Send" [disabled, ref=e6]
```

That launch's log shows the flavor and the whole turn in one stream:

```
{"ts":"2026-08-18T16:03:17.421Z","seq":2,"source":"main","event":"adapter_selected","adapter":"sdk","requested":"sdk","reason":null}
{"ts":"2026-08-18T16:03:38.654Z","seq":9,"source":"main","event":"prompt","adapter":"sdk","turnId":"t-1","prompt":"Say hello in five words."}
{"ts":"2026-08-18T16:03:38.655Z","seq":10,"source":"main","event":"turn_started","adapter":"sdk","turnId":"t-1"}
{"ts":"2026-08-18T16:03:40.699Z","seq":11,"source":"main","event":"text_delta","adapter":"sdk","turnId":"t-1","delta":"Hello"}
…
{"ts":"2026-08-18T16:03:40.869Z","seq":17,"source":"main","event":"turn_ended","adapter":"sdk","turnId":"t-1"}
```

### Closing the window mid-turn disposes the SDK session

Same launch. A second prompt — "Count from 1 to 200, one number per line,
nothing else." — was sent, and the window was closed four seconds into the
stream (`window.close()` through Agent Browser). The log ends where the window
did:

```
{"ts":"2026-08-18T16:04:59.383Z","seq":241,"source":"main","event":"text_delta","adapter":"sdk","turnId":"t-2","delta":"\n"}
{"ts":"2026-08-18T16:04:59.396Z","seq":242,"source":"main","event":"windows_closed"}
{"ts":"2026-08-18T16:05:11.722Z","seq":243,"source":"main","event":"app_quitting"}
```

224 records for `t-2`, the last of them the delta `"111"` — then nothing. This
is evidence about the *session*, not merely about the channel: `withLogging`
subscribes to the adapter directly and never unsubscribes, so a session left
streaming would have gone on writing `text_delta` records into this file with
no window to send them to. It wrote none, and no `turn_ended` or `error`
followed: the turn was abandoned and the session disposed.

At the adapter's own interface, headless, same result — a turn was disposed
after three deltas of a 200-line count:

```
event turn_started
disposing mid-turn after 3 deltas
exited 3.1s after dispose; events after dispose: 0
```

The process ended on its own three seconds after `dispose()` rather than
running the count to completion, so nothing was left holding the event loop:
`AgentSession.dispose()` only detaches listeners, and the adapter therefore
calls `abort()` first — that is what stops the paid request.

### `npm test` with credentials present makes no network call

`npm test` → 12 files, 114 tests, green, in under a second. No test constructs
the SDK adapter: `toPortEvent` lives in its own module that imports the SDK for
**types only**, so nothing SDK-shaped is loaded at runtime by the suite, and
`select-adapter.test.ts` deliberately no longer exercises the
`CRUCIBLE_AGENT=sdk` row of D5's table (that row is proved by `prove:sdk` and
`dev:sdk` instead). `npm run lint` and `npm run typecheck` are green too.

### D11 settled: credentials in, the legacy system out

The UNVERIFIED row "`createAgentSession()` with default `agentDir` would load
the legacy packages" was checked directly rather than through `prove:sdk`'s
stdout — widening the adapter's interface to expose its session just so a
script could print a package list would have cost more than the fact is worth.
Building both settings managers side by side, then the session exactly as
`createSdkAdapter` builds it:

```
in-memory settings packages: []
on-disk  settings packages: ["../../repos/pi-extensions"]
extensions loaded: []
extension errors: []
active tools: []
```

So the guess was right and D11's remedy works: the settings the SDK would have
loaded by default do carry the legacy system, `SettingsManager.inMemory()` keeps
them unread, and nothing from `../../repos/pi-extensions` reaches a Crucible
session — while the default `agentDir` still resolves `auth.json`, which is why
the runs above authenticate at all. `noTools: "all"` is visible in the same
place: no active tools.

### Follow-up this slice deliberately did not take

**Port `anthropic-pi-symbol` behaviour into the SDK adapter when Crucible
re-pins Anthropic.** Anthropic sessions draw subscription usage only when the
product name `pi` is rewritten to the π symbol in the system prompt; the legacy
system does it in an extension of that name. A bare `createAgentSession` lacks
the rename and routes to the extra-usage pool, which is what the 400 above is.
Until that behaviour exists here, `SDK_MODEL` names a provider that answers.

### Toolchain notes

- The SDK is ESM-only and its `exports` map has no `require` condition, so
  `require('@earendil-works/pi-coding-agent')` fails outright with
  `ERR_PACKAGE_PATH_NOT_EXPORTED` — not something Node 22+'s `require(esm)`
  rescues. The adapter therefore loads it with `import()`, which rollup keeps as
  a real dynamic import in the CommonJS main bundle (verified in
  `out/main/index.js`). A fake-flavor launch never loads the SDK at all.
- `prove:sdk` runs the adapter under plain Node's type stripping, whose ESM
  resolver does no extension guessing, so `sdk-adapter.ts` imports its mapping
  as `./to-port-event.ts` (hence `allowImportingTsExtensions` in
  `tsconfig.node.json`) and the script is run with
  `--disable-warning=MODULE_TYPELESS_PACKAGE_JSON` to keep its stdout clean in a
  package with no `"type": "module"`.

## 2026-08-18 — slice 7 fix round (review finding: provider payloads at the port)

The review of slice 7 blocked on `error.message` carrying the provider's
payload across the agent port, against the Contracts' "`error.message` is
display-safe text for the pane. Stacks, SDK error objects and provider payloads
go to the log (D8), never into the event." Every `code: "adapter"` event in the
SDK path is now built by one function, `adapterError`, and the raw cause stops
there.

### What a provider payload becomes at the port

The 400 that the exhausted Anthropic pool answers with (recorded verbatim
earlier in this file) reaches the port as its sentence and nothing else:

```
in : 400 {"type":"error","error":{"type":"invalid_request_error",
     "message":"You're out of extra usage. Add more at claude.ai/settings/usage and keep going."},
     "request_id":"req_011CeAV1UmHy2dgWny5Qq66M"}
out: { type: "error", turnId: "t-1", code: "adapter",
       message: "You're out of extra usage. Add more at claude.ai/settings/usage and keep going." }
```

No `request_id`, no JSON, no status line. A payload with no human sentence in
it, an HTML error page, an `Error` whose message carries a stack, and an SDK
error object handed over as a thrown cause all become
`"The agent failed without saying why."` — 12 cases in
`src/main/agent/adapter-error.test.ts`, plus the mapping's own two in
`to-port-event.test.ts`. `npm test`: 13 files, 124 tests, green; `npm run
lint`, `npm run typecheck` and `npm run build` green, and the fix is in the
main bundle (`adapterError` in `out/main/index.js`).

### `npm run prove:sdk` after the fix — stdout verbatim

```
> crucible@0.0.0 prove:sdk
> CRUCIBLE_AGENT=sdk node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/prove-sdk.ts

prove:sdk — Crucible SDK adapter against the real π SDK
date:   2026-08-18T16:23:19.143Z
model:  openai-codex/gpt-5.4-mini
node:   v25.9.0
prompt: "Say hello in five words."

prompt accepted as t-1
[t-1] turn_started
[t-1] text_delta "Hello"
[t-1] text_delta " from"
[t-1] text_delta " the"
[t-1] text_delta " coding"
[t-1] text_delta " assistant"
[t-1] text_delta "."
[t-1] turn_ended

reply:  "Hello from the coding assistant."
PASS — turn_started, 6 text_delta, turn_ended
```

Exit code 0, one turn, well inside the 60s deadline: the happy path still
streams real model text through the adapter after the change. Who ran it: the
fix agent, to verify the change end to end. The done-criterion's own run — the
one a **human** performs — is the operator entry below.

### The authorized proof run — `npm run prove:sdk`, stdout verbatim

**Authorization.** The spec's owner amended the done-criterion's intent for this
milestone: a **human authorizes** the paid proof; an agent may execute and
record it. This run was authorized by the spec's owner and executed at their
direction in this worktree on 2026-08-18, against the fixed adapter. It is the
run the criterion asks for, and it is not to be repeated — each run spends
money.

```
> crucible@0.0.0 prove:sdk
> CRUCIBLE_AGENT=sdk node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/prove-sdk.ts

prove:sdk — Crucible SDK adapter against the real π SDK
date:   2026-08-18T16:22:56.128Z
model:  openai-codex/gpt-5.4-mini
node:   v25.9.0
prompt: "Say hello in five words."

prompt accepted as t-1
[t-1] turn_started
[t-1] text_delta "Hello"
[t-1] text_delta " there"
[t-1] text_delta ","
[t-1] text_delta " happy"
[t-1] text_delta " to"
[t-1] text_delta " help"
[t-1] text_delta "."
[t-1] turn_ended

reply:  "Hello there, happy to help."
PASS — turn_started, 7 text_delta, turn_ended
```

`turn_started`, seven `text_delta` and `turn_ended`, in that order, well inside
the 60-second deadline; model id `openai-codex/gpt-5.4-mini` and date
`2026-08-18T16:22:56.128Z` are in the stdout above, and no credential is
printed.
