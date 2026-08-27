# 0023 — A scheduled run parks until a session adopts it

Schedules start runs with nobody listening, and ADR 0017 gives a run no
voice except a message to its orchestrator session. We decided a scheduled
run has no orchestrator at all until one is chosen: a question, a stall, or
a failure parks the run, the schedule board surfaces it, and "take to a
session" adopts the run into a session where the ordinary orchestrator
contract takes over. Clean completions never demand attention — they land
on the board as reports. ADR 0017 holds: the board never answers a run, and
ADR 0002 holds: no session is ever created except by the user's act.

## Consequences

Attention for scheduled runs rides a top-bar chip and the Tab walk, not a
session. A parked run can wait indefinitely at no cost. The engine's
existing adopt() is the whole handoff mechanism.

## Considered Options

A standing per-workspace orchestrator session was rejected because it
plants an uncurated session in the sidebar and accumulates unrelated run
traffic forever. A fresh session per fire was rejected as a sidebar pile.
An answer box on the board was rejected in ADR 0017 and stays rejected.
