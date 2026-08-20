# Build plan — context panel

A markdown exhibit the fake adapter shows on the `panel` prompt. It is here so
that every panel behavior can be driven for free, by an agent or by a test.

## Steps

| Step | What it covers | State |
| --- | --- | --- |
| 1 | Tabs, kind badges, the active accent line | done |
| 2 | Re-show refreshes a tab in place | done |
| 3 | Close by id, close all, the curation nudge | done |

## Rendering

Markdown exhibits go through the app's own markdown component, so a table, a
heading and a fenced block all render the way the transcript renders them:

```ts
const result = panel.show(sessionId, workspacePath, path, 'Build plan')
```

Prompt the session with `tidy the panel` to close one tab, or
`close the panel` to empty it.
