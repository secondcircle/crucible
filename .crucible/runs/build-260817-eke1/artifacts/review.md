# Review — slice 1/7 `scaffold-dev-loop`

## Verdict

**APPROVED.** No blocking defects or scope creep were demonstrated.

## Blocking findings

None.

No prior review repro tests were present in the artifact directory.

## Spec verification

- **Sandboxed window and bundled preload:** `createMainWindow` explicitly sets `sandbox: true`, `contextIsolation: true`, and `nodeIntegration: false`, and points at the single generated `out/preload/index.js`. In a fresh launch, the renderer exposed no `require`, `process`, or `module`; after reload its console contained `[crucible] preload loaded`.
- **Renderer HMR:** the dev branch loads `process.env.ELECTRON_RENDERER_URL`. While the app was running, changing the React text to `Scaffold running — reviewer HMR probe.` updated the attached window without reloading the preload; the console reported `[vite] hot updated: /src/App.tsx`. The source edit was restored.
- **Agent Browser / port 9222:** `npm run dev` produced `DevTools listening on ws://127.0.0.1:9222/...`; `agent-browser connect 9222` and `snapshot` showed the Crucible heading and scaffold text. `lsof -nP -iTCP:9222 -sTCP:LISTEN` showed Electron listening only on `127.0.0.1:9222`.
- **Busy-port behavior:** with one app on renderer URL 5173, a second ordinary `npm run dev` opened its renderer on 5174 and logged `bind() failed: Address already in use (48)` plus `Cannot start http server for devtools.` The sole 9222 target remained the first app at `http://localhost:5173/`. This matches both the evidence file and `AGENTS.md`.
- **Required checks:** independently reran `npm run lint`, `npm run typecheck`, and `npm test`; all passed, with 1 test file / 1 test passing. A separate clean temporary `npm ci` installed the Electron binary through the root `postinstall`, after which all three checks also passed.

All review-launched Electron/Vite processes were stopped; ports 9222, 5173, and 5174 were clear afterward.

## Scope-fidelity audit

- `package.json` / `package-lock.json`: electron-vite + React scaffold, required dev command, lint/typecheck/test harness, and dependencies needed by D2/D10.
- `electron.vite.config.ts`: main/preload/renderer builds, single bundled CommonJS preload, and React fast refresh.
- `src/main/**`: app lifecycle and the sole sandboxed `BrowserWindow`, including the dev-URL HMR branch.
- `src/preload/index.ts`: minimal load proof only; it exposes no agent channel early.
- `src/renderer/**`: the deliberately minimal React tree and one jsdom Testing Library harness test.
- `eslint.config.mjs`, TypeScript configs, Vitest config/setup: required green lint, typecheck, and D10 test commands. No future renderer import fence was added.
- `.gitignore`: ignores the build-info files emitted by the composite typecheck projects.
- `AGENTS.md`: required fixed-port recipe, loopback fact, `lsof` command, and stale-first-launch warning.
- `evidence.md`: required runtime, HMR, bind-address, and busy-port observations.

No agent port, adapter, log sink, IPC channel, import fence, SDK dependency, `dev:sdk`, or `prove:sdk` implementation from slices 2–7 is present. The other `.crucible/runs/steer-*` files shown by `git status` are the pre-existing workflow record that produced the supplied steering-document input, not slice implementation.

## Nits

1. The evidence introduction says the scaffold was “committed by slice 1,” but all application files are currently untracked and `impl-notes.md` says no git state was touched. This is a clerical inconsistency, not a behavior defect.
2. On the repository’s Node v25.9.0, clean `npm ci` emits an `EBADENGINE` warning because `jsdom@30.0.1` does not declare Node 25 support. Installation and the jsdom test both succeeded, so no required behavior is broken.
