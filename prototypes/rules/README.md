# crucible-rules-proto

A standalone prototype of Crucible rules: one rule file, its companion test file, and a runner that replays real history through the same pipeline the live hooks would use. It's not part of the app: nothing in `src/` imports it, and the app has no rules integration. It reads this checkout through git and never writes to it. Rule files live where Crucible would look for them, in `<repo>/.crucible/rules/`. `HANDOFF.md` has the context and the results.

Node 24 or newer runs the TypeScript directly (type stripping), so there is no build step. Run `npm install` here first; this folder has its own dependencies.

```
node src/cli.ts test comments [--extract-only] [--budget 0.50] [-v]
node src/cli.ts explain comments src/main/agent/sdk-adapter.ts:376 [--at HEAD]
node src/cli.ts survey comments [--extract-only] [--limit N] [--budget 0.50]
```

Judge calls need `TYPESAFE_API_KEY`, either in the shell or in `.env` here (`TYPESAFE_API_KEY=...`). Answers are cached in `.cache/jev/` by (model, state, questions), so re-running after a threshold change costs nothing. Rewording a question re-calls only what changed. Uncached calls are refused when the estimate would pass `--budget`.

`survey` writes `reports/<rule>-survey.html` (open it in Crucible's context panel) and a JSON of every row.

Labels come from every commit whose message says "comment police": a comment the police removed or rewrote is a violation, and a comment the branch added that the police left alone is kept. See `src/labels.ts` for the heuristics and their limits.
