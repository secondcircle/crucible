# 0009 — Exhibits serve under their own origin, and one header is their whole policy

Exhibits used to render via `srcdoc`, which put agent-authored HTML inside the
renderer's origin and forced `script-src 'unsafe-inline'` into the renderer's
CSP — one XSS away from `window.crucible.agent` and a bash-running agent. We
decided exhibits are their own origin: a custom `exhibit://` scheme serves
them, and the response's `Content-Security-Policy` header is the whole of the
exhibit's policy. It starts from `default-src 'none'`, allows the exhibit's
own inline script, inline styles and `data:` images, and denies every network
source, subresource, nested frame and object; `form-action` and `base-uri`
are spelled out because neither falls back to `default-src`. The scheme is
registered standard and secure but never `bypassCSP`: the renderer admits the
frame through its own `frame-src exhibit:` (its `script-src` back to
`'self'`), and the exhibit document limits itself from there. That one
decision is spread across four files — the scheme registration, the handler,
the renderer's CSP meta tag, and the frame — and looks arbitrary in each,
which is why it is argued here and not in comments. Extending ADR 0008, the
scheme handler sits under the launch's one panel model rather than beside it:
both adapters keep delegating to that model, the handler asks it a read-only
question, and a file is servable only because some session's tab is showing
it.

## Considered Options

Keeping `srcdoc` and the loosened renderer CSP was rejected as a standing
escalation path. A `file://` or app-origin serve was rejected because the
exhibit would inherit or share an origin that has powers an agent-authored
document must not reach; a separate origin with a deny-by-default header
leaves nothing to inherit.
