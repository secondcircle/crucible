# Spec — exhibits get their own origin; the renderer takes its CSP back

Implements the intent brief at `.crucible/align/260820-exhibit-origin-hardening.md`.
That brief rules the scope; this spec turns its rulings into buildable
instruction. Where the two could ever be read differently, the brief wins.

## The problem, in one paragraph

HTML exhibits in the context panel are injected into their iframe via
`srcdoc`. A `srcdoc` frame inherits the embedding document's CSP, so ruling
Q6 of the context panel brief (exhibit HTML runs its own scripts) forced
`'unsafe-inline'` into the renderer document's `script-src`. The renderer
holds the agent port, and in the SDK flavor that port drives an agent that
runs bash and spends money, so the renderer's script policy is the one
mechanical backstop this app has against a future HTML-injection bug. This
work gives exhibits their own origin with their own CSP, returns the
renderer's policy to `script-src 'self'`, and replaces the "nothing here
builds HTML from text" argument with a lint rule.

## What ships

Four deliverables, none optional:

1. A custom `exhibit` scheme in the main process that serves an HTML
   exhibit's bytes to the panel's iframe via `src`.
2. The renderer's CSP reverted to `script-src 'self'`, with the comment that
   justified the loosening removed.
3. Resolution strictly against the panel model's current tabs, with tested
   refusals.
4. An ESLint restriction banning `dangerouslySetInnerHTML` in the renderer
   scope.

---

## 1. The exhibit scheme

### Name and URL contract

The scheme is named `exhibit`. A request URL has exactly this shape:

```
exhibit://panel/<sessionId>/<tabId>
```

Fixed host `panel`, then two path segments: the session id and the tab id,
each percent-encoded as a URL path segment. Nothing else is ever part of the
contract. No file path, no filename, and no extension appears anywhere in
the URL; the renderer knows a tab by its id and by nothing else, and the URL
carries exactly what the renderer already knows.

One shared module (importable by both renderer and main, in the same spirit
as `port.ts`'s import-nothing discipline: no Electron, no Node, no SDK
types) owns this format. It exports:

- the scheme name as a constant,
- a builder `exhibitUrl(sessionId, tabId): string`,
- a parser that takes a URL string and returns
  `{ sessionId, tabId } | undefined`, refusing anything that is not exactly
  the shape above.

Renderer and main both use this module, so the two ends cannot drift. The
parser refuses, returning `undefined`, when any of these hold:

- the scheme or host is not exactly `exhibit://panel`,
- the path has more or fewer than two segments,
- a decoded segment is empty,
- the URL carries a query string or fragment.

The agent port itself does not change: no new operations, no changed
signatures, no new event types. The URL module is a shared contract beside
the port, not part of it.

### Registration and wiring

- The scheme is registered as privileged before the app is ready
  (`protocol.registerSchemesAsPrivileged`), with `standard: true` and
  `secure: true` so a sandboxed frame may load it. It is **not** given
  `bypassCSP`: the renderer document admits the frame explicitly through its
  own `frame-src`, and the exhibit document gets its policy from the
  response header.
- The request handler is installed once per launch via `protocol.handle` on
  the session the app window uses, and it delegates to the one panel model
  the launch already holds. This is main-process plumbing under the same
  panel model that ADR 0008 placed behind the agent port; it is not a second
  seam, and both adapters keep delegating to that same model untouched.
- The request-to-response decision lives in a plain function that takes the
  panel model and the request URL and returns a description of the response
  (status, headers, body). The `protocol.handle` wiring is a thin translation
  of that description into a `Response`. This split exists so the decision is
  testable under vitest without Electron.

### The served response

A request is served, status 200, exactly when all of these hold:

- the method is GET,
- the parser accepts the URL,
- the named session currently has a tab with the named id (any session's
  tabs qualify, not only the active session's; the model's lazy load from
  persistence applies as it does everywhere else),
- that tab's kind is `html` (markdown exhibits never ride the frame; they
  keep their existing path through the port's `exhibit` operation),
- the tab's file can be read at request time.

The response body is the file's bytes read at request time, never a cached
copy, so a re-shown or externally edited exhibit serves what is on disk now.
The response headers are:

```
Content-Type: text/html; charset=utf-8
Cache-Control: no-store
Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline';
  style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'
```

(The CSP is one header value; it is wrapped here for reading.) That policy
is the whole point of the scheme: the exhibit's own inline scripts and
inline styles run, `data:` images drawn from its own bytes render, and
nothing else is granted. `default-src 'none'` denies every network source,
every subresource file, every nested frame and every object; `form-action
'none'` and `base-uri 'none'` close the two directives that do not fall back
to `default-src`. Navigation containment stays where it already is, in the
frame's sandbox attribute, which this work does not touch.

### Refusals

Every request that is not served is refused: status 404, `Content-Type:
text/plain; charset=utf-8`, `Cache-Control: no-store`, and the same
restrictive CSP header as above. A refusal body is a short fixed sentence
and never echoes the request URL or any part of it back (nothing an attacker
controls is reflected). Two bodies exist:

- **Not shown**: the parser refused the URL, the session or tab is unknown,
  or the tab is not an HTML exhibit. Body: `Not an exhibit the context panel
  is showing.`
- **Unreadable**: the tab exists but its file cannot be read (vanished,
  permission, anything). Body: `That exhibit could not be read:
  <basename>.` This is the same honest-data stance the port's `exhibit`
  operation already takes, basename and all, and never a stale copy. The tab stays
  open; curation remains the agent's.

Traversal is refused structurally, not by sanitization: no part of the URL
is ever treated as a filesystem path. Resolution is an exact string lookup
of the decoded segments against session and tab ids, and no id contains a
path separator, so `..`, encoded separators, and every other smuggling shape
fall into "not shown". The handler performs no filesystem access except
reading the path the panel model holds for a matched tab.

Consequences worth naming so their absence would be conspicuous:

- Closing a tab (agent `panel_close` or the user's ×) makes its URL refuse
  from then on.
- Session reset and session removal make all of that session's exhibit URLs
  refuse.
- A request with a query string is refused outright; there is no
  cache-buster query, because `Cache-Control: no-store` already forces
  refetch.

## 2. The renderer's CSP

`src/renderer/index.html` changes in exactly two ways:

- `script-src` returns to `'self'` alone; the `'unsafe-inline'` token and
  the comment block that justified it are removed.
- `frame-src exhibit:` is added, with a short comment saying why: the
  context panel's HTML exhibits load from their own origin under their own
  policy, and this token is what admits the frame.

Everything else in the policy stays as it is (`default-src 'self'`,
`style-src 'self' 'unsafe-inline'` for React inline styles, `img-src 'self'
data:` for image attachments). After the change,
`grep unsafe-inline src/renderer/index.html` must find no trace of the
`script-src` loosening; the acceptance check below is stated as the exact
command the intent gives, so the builder must confirm what that command
finds and that no script-src loosening survives.

> Precision note: the intent's acceptance says the grep "finds nothing".
> `style-src 'unsafe-inline'` predates this work, was never the finding, and
> is required by React's style props. If the builder can drop it without
> breaking the shell's rendering, do so and make the grep literally empty;
> if not, the binding requirement is that `script-src` contains only
> `'self'` and the justifying comment is gone. Do not widen scope to
> restyle the app.

## 3. The renderer's exhibit view

- An HTML exhibit's iframe gets `src={exhibitUrl(sessionId, tabId)}` from
  the shared URL module. The `srcDoc` attribute disappears; no `srcdoc`
  remains anywhere in the renderer.
- The `sandbox` attribute stays exactly `allow-scripts`: unique opaque
  origin, no Node, no preload bridge, no app access. Not one token is added
  or removed.
- The renderer no longer calls the port's `exhibit` operation for HTML tabs.
  The frame is remounted (React `key` derived from the existing
  session-tab-`shownAt` identity) when a re-show refreshes the tab, so a
  refresh reloads the frame and `no-store` guarantees fresh bytes.
- Markdown exhibits are untouched by all of this: same `exhibit` call
  through the port, same `Markdown` component, same inline failure message,
  same tests. The port's `exhibit` operation stays on the port unchanged.
- Q6's user-visible behavior is preserved: an HTML exhibit renders, its
  inline scripts run, and it can reach nothing outside its own bytes.

## 4. The lint fence

In `eslint.config.mjs`, in the same renderer-scoped block that carries the
import fence and the `window.crucible` fence, the `no-restricted-syntax`
list grows entries banning `dangerouslySetInnerHTML`, covering both spellings:

- the JSX attribute (`JSXAttribute[name.name='dangerouslySetInnerHTML']`),
- the object property, which catches `createElement` props and spread
  objects (`Property[key.name='dangerouslySetInnerHTML']`).

The message states the stance: the renderer's `script-src 'self'` is the
app's backstop against HTML injection; if a legitimate need appears, the
exception is argued in review, not taken silently.

The four files that already switch `no-restricted-syntax` off
(`bridge.ts` and the three ipc-client tests) are thereby exempt from the new
entries too. That is accepted: none of them renders JSX, and re-plumbing the
exemptions is out of scope.

## What must not change (binding boundary)

- **Q6 behavior**: HTML exhibits render and their scripts run inside a
  sandboxed frame with browser-page rules. Markdown exhibits are untouched.
- **The agent port's shape**: no new operations, no changed signatures.
  Panel state still rides the port as snapshot and events (ADR 0008); the
  scheme handler sits under the same panel model, never beside it.
- **The panel model's tool semantics**: `panel_show` / `panel_list` /
  `panel_close` results, ages, dedupe, persistence, restore-and-drop, all
  exactly as they are. If the handler needs a read the model does not yet
  expose (the tab's path and kind by session and tab id), the model grows
  that one read-only query and nothing else observable.
- **The renderer never touches the π SDK** (ADR 0001); the import fence and
  the `window.crucible` fence stay word-for-word, plus the new rule.
- **The frame's sandbox attribute** and the window's `webPreferences` are
  untouched.
- **The fake adapter still drives every panel behavior at zero cost**;
  `npm test` constructs no SDK adapter and starts no Electron.
- All existing panel tests keep passing, updated only where this spec
  changes the behavior they assert (the `srcdoc` assertions).

## Out of scope

- Serving markdown, images, or any subresource through the scheme; exhibits
  remain single self-contained files (Q5 stands).
- Any relaxation of the exhibit CSP beyond the header given above (no
  network sources, ever).
- Refresh, open-in-browser, reorder, or any other deferred panel
  affordance.
- Packaged-build concerns; nothing here ships a packaged build.
- Restructuring the ESLint exemption list or adding fences beyond the one
  named.

## Testing intent

The proof is external behavior at two seams, one of them new.

**New seam: the handler decision function.** `protocol.handle` cannot run
under vitest, so the request-to-response function is the one new seam, and
it is as high as a testable seam can sit here: everything below it (model,
filesystem) is real. Tests construct a real panel model with
`memoryPanelPersistence`, show real temp-directory files through the model's
own `show`, and assert on the returned response description. Required
tests, node-environment vitest beside the model's existing tests:

1. **Served**: an HTML tab's URL yields 200, the file's bytes, and exactly
   the Content-Type, Cache-Control and Content-Security-Policy headers
   specified above.
2. **Fresh bytes**: after the file is rewritten on disk, the same URL serves
   the new bytes.
3. **Unknown refused** (intent-mandated): a URL naming a tab no session
   shows yields the not-shown refusal, as does an unknown session.
4. **Vanished refused** (intent-mandated): a shown tab whose file is then
   deleted yields the unreadable refusal, never the old body.
5. **Traversal refused** (intent-mandated): URLs smuggling `..`, encoded
   separators, extra segments, and a query string all yield the not-shown
   refusal, and the handler reads no file for any of them.
6. **Markdown refused**: a markdown tab's URL yields the not-shown refusal.
7. **Closed refused**: after `panel_close`, the former tab's URL yields the
   not-shown refusal.

**Shared URL module**: builder and parser round-trip ids that need
encoding; the parser refuses each malformed shape listed in its contract.
(These may live inside the handler tests if that keeps the suite smaller;
the behaviors must be asserted somewhere.)

**Existing seam: the renderer against the scripted port.** Update
`Shell.panel` tests where they assert the old mechanism, prove the new one,
and change nothing else:

- the HTML exhibit frame carries `src` equal to the shared builder's URL
  for that session and tab, no `srcdoc`, and `sandbox="allow-scripts"`
  exactly;
- no `exhibit` port call is made for an HTML tab;
- a re-show of an HTML tab replaces the frame (remount), the observable
  form of "reloads";
- every markdown assertion (render, refresh re-fetch, inline failure)
  stands unmodified.

**No new renderer seam.** The scripted port already covers the renderer;
the frame's actual document load is an integration fact only a real Chromium
can show, which is what the fake-flavor walk is for.

**Fake-flavor walk (acceptance, agent-driven, zero cost)**: `npm run dev`,
`agent-browser connect 9222`, drive a canned turn that shows the
`benchmark.html` fixture, and confirm the computed score and "samples
measured by this page's own script" text appear, proving the exhibit's
inline script ran under the new origin while the renderer's CSP forbids
inline script.

**Lint fence check (acceptance, demonstrated, not committed)**: a scratch
file under the renderer tree using `dangerouslySetInnerHTML` fails
`npm run lint`; the scratch file is then removed. This matches the existing
fences, which are also verified by demonstration rather than by a committed
test.

## Acceptance checklist

All of these, verified, before this work is done:

- [ ] `grep unsafe-inline src/renderer/index.html` shows no `script-src`
      loosening (see the precision note in §2), and the justifying comment
      is gone.
- [ ] An HTML exhibit with an inline `<script>` still runs it in the panel:
      fake-flavor walk via agent-browser as described above.
- [ ] A scheme request for anything no tab shows is refused, with tests
      (unknown, vanished, traversal at minimum).
- [ ] The lint rule fails a renderer file using `dangerouslySetInnerHTML`.
- [ ] No `srcdoc` remains in the renderer; the frame's sandbox is unchanged.
- [ ] `npm run lint`, `npm run typecheck`, `npm test` all green, with
      `npm test` constructing no SDK adapter and no Electron.
