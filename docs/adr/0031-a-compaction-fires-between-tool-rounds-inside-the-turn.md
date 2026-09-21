# 0031 — A compaction fires between tool rounds, inside the turn

Crucible's compaction rules were asked between turns: a conversation's size
was weighed when its turn settled, and the idle clock ran while nothing was
happening. A send that arrived during a compaction waited on it. That shape
fitted a chat, and it never fired for a workflow node at all, because a node
is one turn: one prompt, then hours of tool calls with no "between". A node
that read files for a day grew to the model's window and errored there, and
nothing in Crucible had been asked. We decided that the compaction fires
inside the turn, between one tool round and the next, and that this is the
same compaction with the same rules and not a second one. π's agent loop has
a check at exactly that point — `contextTokens > contextWindow -
reserveTokens`, run before each provider request — and it fires the same
`session_before_compact` hook Crucible's manual compaction does, so the
account, the skeleton and the entry are written by the same code and the
loop continues on the rebuilt context with nothing kept verbatim. Crucible
arms that check by deriving `reserveTokens` from its own `sizeTrigger`: the
smallest size at which the between-turn rule would fire is the size the
in-turn check fires at, computed from the predicate rather than written
beside it, and re-derived whenever the size or the conversation's own last
compaction moves. The pause is π's: the loop waits for the compaction
request between two rounds, some tens of seconds, and the agent reads its
account and carries on. A concurrent version, where the summary is written
alongside the working agent and everything since the ask stays verbatim,
was considered and is not ruled out; it needs Crucible to append the entry
itself and rebuild the loop's context at a safe point, and the in-loop pause
was judged not worth that machinery yet. The between-turn rules stay for
the case they still cover: a turn that crosses the size on its final round,
and the idle clock.
