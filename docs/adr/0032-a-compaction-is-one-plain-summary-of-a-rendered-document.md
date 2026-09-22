# 0032 — A compaction is one plain summary of a rendered document

The compaction ADR 0030 shaped appended its instruction to the live
conversation, so the summarizing request read the provider's cached prefix,
and asked for two things: a trajectory summary, and a strike list against a
numbered skeleton of the compacted span that carried the user's words verbatim
and the opening of every reply the model had given. On one session in
September 2026 the provider's output classifier refused fourteen of sixteen
such requests mid-stream as "reverse engineering or duplicating model
outputs", each refusal cancelled the compaction, and the conversation grew
past 200k with no compaction landing and nothing in the UI saying so. The
request was a 200k prompt that ended by asking the model to write an account
of its own work over a list quoting its own prior replies, on a subscription
token used outside the provider's own client: close to what that classifier
exists to catch. We decided the compaction is one plain request that stands
on its own. Crucible renders the conversation to a markdown document — the
previous summary first, then each message and tool call in order under
headings, results cut to their first 40 lines, thinking left out — and sends
it with a short instruction: summarize this so the assistant can continue as
if nothing had been compacted, keep what is still relevant, drop what is not.
The whole reply is the summary and the whole of what the model reads
afterwards; no tags, no numbered lines, no strike list, nothing kept beside
it. The request carries its own system prompt, no tools and one user message,
so it reads none of the cached prefix and re-bills the conversation once per
compaction; we accepted that over a request the provider will not finish. The
skeleton, the carried state on π's compaction entry and the strike reader are
gone; a stored `state` from an older build is read past. What ADR 0030 and
0031 decided about when a compaction fires and what it keeps verbatim
(nothing) stands.
