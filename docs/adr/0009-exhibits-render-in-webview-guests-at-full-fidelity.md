# 0009 — Exhibits render in webview guests, at full browser fidelity

Exhibits used to serve under a custom `exhibit://` scheme whose deny-by-default
CSP header was the whole policy: no subresources, no network, no navigation.
That made the panel lie — the same file looked one way there and another in
Safari, a sibling stylesheet never loaded, and a localhost app could not be
shown at all. We decided fidelity wins: an HTML exhibit loads in an Electron
`<webview>` guest, straight from its `file:` URL or its http(s) address, and
does everything a browser tab does — scripts run, the network loads, links
navigate in place, a dev server's hot reload works over its own websocket. The
one boundary kept is the process one: the guest is a webContents of its own
with no preload and no node integration, so a page can reach nothing of the
app, and a window it tries to open (`target=_blank`, `window.open`) is handed
to the OS browser. The scheme, its handler and its policy are gone; a markdown
exhibit still rides the port's `exhibit` operation as a string. The run
artifact reader's HTML gets the identical treatment.

## Considered Options

Keeping the locked-down scheme was rejected because the panel's purpose is
showing what a page actually looks like, mostly for local testing, and a
policy that breaks rendering protects the wrong thing. A sandboxed iframe
with a loosened CSP was rejected: frame-busting headers block real sites, and
in-place navigation plus a reload control need the guest APIs an iframe does
not have.
