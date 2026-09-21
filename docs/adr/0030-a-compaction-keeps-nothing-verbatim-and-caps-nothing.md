# 0030 — A compaction keeps nothing verbatim and caps nothing

Crucible's compaction as first built left three things behind: the model's
trajectory summary, a skeleton of the compacted span, and a recent span of
20k tokens kept verbatim behind them, cut back to a user-message boundary.
The summary was asked for under 1,200 words and the skeleton was trimmed to a
20k budget, oldest lines first, sparing the user's own words. One session
that ran four days on those rules compacted 198k tokens to 65k, and the 65k
was the case against them. The model had written 230 tokens of it. The
verbatim tail was 34k, the largest single part, and carried whatever the last
few turns happened to be. The skeleton was 31k, over its budget, and every
line of it was kind `user`: an older build had stored run reports and
check-ins as the person's words, the skeleton is carried whole into each next
compaction, and the trim could not touch them, so it had dropped every reply
and every tool call instead and left a list of stale reports with no trace of
what the agent had done. Separately, every idle compaction had committed a
reply the provider cut mid-word, each replacing a 1,000-word account with its
first paragraph, because the reply's stop reason was never read and an
unclosed tag was accepted. We decided that a compaction stands for everything
up to the moment it was asked for, and nothing of that span stays verbatim:
what the model reads afterwards is the account and the skeleton, then
whatever arrived after the ask. Compactions run between turns with sends
waiting on them, so that is the cut the conversation already has. We also
decided that no rule of size touches what the model wrote or what it left:
the account is as long as the model makes it, the skeleton is what the strike
list leaves, and the only mechanical rule is that a reply the provider did not
finish is refused and the previous compaction stands. Carried skeletons are
re-read with the current build's kinds so a stored shape catches up with the
code reading it. The threshold arithmetic keeps an expectation of what a
compaction leaves, 20k, used only until the conversation has compacted once
and reports its own number; it caps nothing.
