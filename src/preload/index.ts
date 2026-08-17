// The preload is bundled to a single file so it loads under `sandbox: true`
// (D2, A5). It exposes nothing yet: the `window.crucible.agent` surface (D7)
// arrives with the agent channel. This line is how a running app shows the
// bundled preload was loaded — it appears in the renderer's console.
console.info('[crucible] preload loaded')
