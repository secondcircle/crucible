# 0029 — Workflow code runs in a workflow host, never on the main thread

A workflow file is a repository's TypeScript, and until now the engine ran it
where the engine lives: on Electron's main thread, the one that pumps the
window's input, its IPC and the run log. Whatever that code did synchronously,
Crucible did synchronously. A build workflow whose mechanical gate ran
`spawnSync('make check')` froze the installed app for the length of a Go test
suite, five minutes at a time, beachball and all: the stall watchdog put four
`main_stalled` events on the run log that day, of 220s, 220s, 511s and 489s,
and the app was frozen for 24 of the 28 minutes it had been up. We decided
that repo-authored workflow code never runs on the main thread. It runs in a **workflow host**: a utility process of its own, one per
workflow file, started by the engine. The file's `run()`, `plan()`, every
`NodeSpec.check()`, a schedule's `check()` and the file's own top-level code
all execute there. The engine stays in main and stays the engine — records,
node sessions, orchestrator messages, pause, cancel, resume, replay — and the
`ctx` a workflow sees is a proxy whose every call is a message to it. What a
loader hands back is a manifest, the file's declarations minus its functions,
read by a short-lived host and kept until the file's bytes change, plus a way
to open a fresh host for the run.

## Consequences

Synchronous work in a workflow file holds that file's host and nothing else.
Cancel becomes total for the first time: the engine kills the process, so a
file spinning in a loop or parked in a synchronous call ends where it stands
instead of outliving its run. A host that dies takes only its run down, with
its stderr on the run's error. The authoring contract moved by two signatures,
`derive()` returning a promise and `check()` allowed to, because nothing that
crosses a process boundary can be synchronous. The cost is a process spawn per
run, per manifest read and per schedule check, on the order of a hundred
milliseconds each, against runs that take minutes to hours. The engine's own
tests run against an in-process host that calls the definition directly; the
host's contract suite runs every case against both that and the real forked
process, so the stand-in cannot drift from the thing it stands for. Node
sessions stay in main on purpose: they are Crucible's own asynchronous code
against the SDK adapter, and the line that matters is Crucible's code against
the repository's.

## Considered Options

Keeping the in-process shape and fixing the offending workflow was rejected:
the defect is a boundary Crucible lacked, and the next file would find it
again. That option was in fact tried alongside this one — the shipped
examples' `spawnSync('git', ...)` and the authoring page's `execFileSync`
schedule check, which were teaching the very habit that froze the app, were
rewritten to spawn and await — and it changes nothing about a file Crucible
has not written. A worker thread
was rejected because `worker.terminate()` waits for the next JavaScript
safepoint, so a worker parked in `spawnSync` stays parked until the child
exits, which is exactly the case cancel has to end at once; `utilityProcess`
kills. Moving the whole engine, node sessions included, into the utility
process was rejected as dragging the agent port along for no gain in
isolation. Documentation alone, telling authors to keep workflow code async,
was rejected: a rule the app cannot enforce is a rule the app will eventually
freeze on.
