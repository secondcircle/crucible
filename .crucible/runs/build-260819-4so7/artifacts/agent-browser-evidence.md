# Driving the built shell — commands, settings, usage

Everything below ran against the **fake** launch flavor
(`CRUCIBLE_WORKSPACE=/tmp/crucible-cmd-ws npm run dev`, `agent-browser connect 9222`).
No SDK adapter was constructed, no network call left the machine, nothing was
paid for. The numbers the Usage tab shows are the fake adapter's canned
per-message usage.

## Command mode and the popover

Typing `/` flips the composer to command mode — purple box, `COMMAND` badge —
and opens the popover above it:

```
{ "badge": "command", "mode": "cbox cmd",
  "rows": [
    "/align[subject]Grill an idea into shared understanding, ending in an intent briefbuilt-in",
    "/component<name> [features…]Create a React componentworkspace",
    "/review<PR-URL>Review a pull request with structured issue and code analysisuser",
    "/standupSummarize yesterday, today and blockers from gitworkspace" ] }
```

All three origins are on screen with their badges, and the two hint styles
(`<required>`, `[optional]`) are shown verbatim. Screenshot of `/comp` filtered
down to one row: `/tmp/crucible-command-mode.png`.

Enter inserts the selected name with its trailing space, sending nothing:

```
{ "afterInsert": "/align " }
```

## Sending a command, and the row it leaves

Typing `/align the command system` and pressing Send:

```
{ "compact": "▸/align the command system command",
  "opened": "Interview me about the command system until we reach shared
             understanding, then write the intent brief.",
  "draft": "" }
```

The transcript row is the invocation; clicking it opens to exactly the text
that crossed the port. Nothing command-shaped crossed: the port received the
expanded prompt alone.

## Settings from the gear

```
{ "tabs": ["Providers*", "Usage"],
  "rows": [
    "AnthropicSigned in — Claude subscriptionLog out",
    "OpenAIAPI key storedLog out",
    "GoogleAPI key from environment (GEMINI_API_KEY) — managed outside Crucible—" ] }
```

Signed-in providers only; the environment row's action is disabled and says
why. The gear is present with no workspace and no session, since providers are
global.

## A whole login, walked

Add provider → OpenRouter (both methods) → Sign in with OAuth:

```
{ "picker": ["OpenRouterOAuth · API key", "GroqAPI key"],
  "dialog": "Log in to OpenRouter · Your browser opened for authorization. ·
             https://example.invalid/authorize?provider=openrouter ·
             If it doesn't come back, paste the redirect URL or code here: · Cancel Continue" }
```

Pasting anything and pressing Continue ends the flow and the provider joins the
list:

```
"OpenRouterSigned in — the fake flow, no networkLog out"
```

Escape order, with a login dialog open over the sheet:

```
first Escape  → { "login": false, "sheet": true }
second Escape → { "sheet": false }
```

An API-key flow masks the field: `{ "asked": "Paste your Groq API key.", "masked": "password" }`.

## Usage, from the chip

One scripted turn, then a click on the top-bar cost chip:

```
chip:  "$0.84"
cards: ["Cost$0.84", "Tokens61,982", "Messages1", "Context0%"]

This session      Input       4,210  $0.06
                  Output     18,772  $0.56
                  Cache read 36,900  $0.11
                  Cache write 2,100  $0.11
                  Total      61,982  $0.84

Sessions in this workspace
                  Session · 1:27 AM    —      —       —
                  Session · 1:29 AM    1      62k     $0.84
                  Workspace total      1      62k     $0.84
```

A session that has reported nothing shows dashes and contributes nothing to the
totals. Before the first turn the chip itself is a dash, under the same honesty
rule the context meter follows.

## Checks

```
make validate → typecheck, lint, 584 tests, build — green
npm test      → 55 files, 584 tests, no paid call, no SDK adapter constructed
```
