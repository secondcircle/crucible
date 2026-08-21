// The authoring surface lives with the shipped workflows, because the same
// module the engine types against is the one the loader aliases in for every
// workflow file (`crucible:workflow`). This re-export is how the engine
// reaches it without a second copy that could drift.

export * from '../../../resources/workflows/lib/workflow'
