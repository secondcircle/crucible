# 0002 — Sidebar sessions are curated

A workspace may have a large amount of adapter-managed conversation history, so backing-store discovery is not a usable sidebar model and persisted history must not imply UI membership. Crucible therefore owns a curated list of sessions for each workspace: creating or explicitly resuming a conversation through the agent port adds one, while removing one only forgets the sidebar entry and never directly manipulates the adapter's storage. This adds app-owned state beside adapter-managed persistence, but keeps the sidebar intentional, bounded, independent of prior work in the folder, and free of π-specific storage concepts.

## Considered Options

Automatically listing every persisted conversation for the workspace was rejected because opening a long-lived folder could flood the sidebar with years of unrelated history.
