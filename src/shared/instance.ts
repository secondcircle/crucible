// The window argument main hands the preload this launch's instance badge on.
// Preload and main have to agree letter for letter, and a mismatch would be
// silent — a dev window with no badge — so the string is spelled once, here,
// in the one place both can see and nothing of Electron rides along.
//
// An argument rather than a channel because the value cannot change within a
// launch: there is nothing to announce and nothing to ask for.
export const INSTANCE_ARGUMENT = '--crucible-instance='
