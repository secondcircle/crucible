# 0022 — Crucible asks for one-hour prompt retention

Main sets `PI_CACHE_RETENTION=long` at startup, before the ledger or any
adapter reads it, so every launch runs the hour: dev, `dev:sdk`, workflow node
sessions, and the packaged app in the Dock. π reads the variable off the
process environment when it builds a request and the SDK runs inside main, so
main is the only place the choice can be made. Nothing that starts Crucible
carries a shell environment worth inheriting — a Dock launch has none at all,
which is why the same block already repairs `PATH`. An explicit
`PI_CACHE_RETENTION` in the environment still wins, and that is not politeness:
it is what lets one build record both halves of the before-and-after the cache
ledger exists to hold.

The trade is priced, not free. Anthropic bills a one-hour cache write at twice
the base input rate against 1.25x for the five-minute one, and reads at a tenth
either way. So the hour loses money on a conversation whose turns come back
inside five minutes and wins whenever the gap runs past it. Crucible's shape
makes those long gaps the normal case: an orchestrator session sits idle while
a workflow run works, comes back to a context it has already paid to cache, and
under the five-minute default re-bills the whole prompt. That is the miss the
ledger kept recording. We are turning the setting on and letting the ledger
score it, which is the experiment it was built for; the reset line is the
boundary to read from.

Because Crucible now chooses, the cache health view stopped reporting the hour
as `PI_CACHE_RETENTION=long` and reports it as Crucible's default. Five minutes
is the line that names the variable, since it can only mean an override.

## Considered Options

Setting the variable in `npm run dev` and `dev:sdk` was rejected: it leaves the
installed app — the human's daily instance, and the one whose sessions sit
idle longest — on the five-minute default, so the flavor the evidence matters
most for would be the one flavor not running the setting.

Passing `cacheRetention: "long"` per request through the SDK's stream options
was rejected as a bigger seam for the same effect: it would put a caching
decision in every call site that opens a session, and it would sever the tie to
`PI_CACHE_RETENTION`, which is the switch anyone reading π's own docs will
reach for.

Exposing the choice as a Crucible setting with a toggle in the UI was rejected
for now. The question is whether the hour pays, and a per-user toggle answers
it with preference rather than data; a build-wide default plus an environment
override collects the same evidence with nothing to maintain. If the ledger says
the hour loses, the fix is to change this line, not to make everyone choose.
