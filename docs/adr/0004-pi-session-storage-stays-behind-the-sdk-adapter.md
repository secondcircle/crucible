# 0004 — π session storage stays behind the SDK adapter

Crucible needs to create, reset, resume, and remove sessions while remaining independent of π's backing format and preserving the agent port as its replacement seam. Crucible-owned interfaces and UI therefore use only Crucible session identities and operations: they never expose, parse, edit, delete, or otherwise reason about π session files, while the SDK adapter alone may translate those operations into π's public session APIs. This indirection is deliberate because directly coupling the curated sidebar model to JSONL paths would leak SDK persistence across the seam and make both testing and any future adapter replacement substantially harder.

## Considered Options

Forbidding even the SDK adapter from using π session APIs was rejected because it would make native persistence and resume impossible; letting Crucible manipulate π files directly was rejected because it would collapse the boundary established by the agent port.
