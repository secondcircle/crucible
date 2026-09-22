import type { CreateModelRuntimeOptions } from '@earendil-works/pi-coding-agent'

// Every π model runtime Crucible creates is built with these, so a model that
// pi.dev lists ahead of the installed SDK's built-in catalog (Opus 5.5 shipped
// there a release early) is known to the picker, the ring and the workflow
// engine alike. π stores the overlay beside its models.json and revalidates
// by etag at most every four hours, so the create-time fetch is usually no
// request at all; past the timeout, or offline, the stored overlay and the
// static catalog stand.
export const MODEL_RUNTIME_OPTIONS: CreateModelRuntimeOptions = {
  allowModelNetwork: true,
  modelRefreshTimeoutMs: 10_000
}
