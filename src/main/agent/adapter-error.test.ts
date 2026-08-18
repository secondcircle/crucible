// @vitest-environment node
//
// `adapterError` is where a failure becomes something the pane can print, for
// both of the directions an SDK turn fails from — a failed event, and a
// `prompt()` that throws. Nothing here loads the SDK: the rule is about text,
// so the causes below are the shapes the SDK hands over, not the SDK itself.
import { describe, expect, it } from 'vitest'
import { adapterError } from './adapter-error'

/** Every answer is a whole port event, so this is what the assertions read. */
function messageFor(cause: unknown, fallback?: string): string {
  const event = adapterError('t-1', cause, fallback) as { message: string }
  return event.message
}

describe('the error event an SDK failure becomes', () => {
  it('is a terminal error for the turn it was asked about, coded adapter', () => {
    expect(adapterError('t-9', 'Model not found: gpt-9.')).toEqual({
      type: 'error',
      turnId: 't-9',
      code: 'adapter',
      message: 'Model not found: gpt-9.'
    })
  })

  it('carries a plain sentence through, from a string or from an Error', () => {
    expect(messageFor('The session was disposed before it finished opening.')).toBe(
      'The session was disposed before it finished opening.'
    )
    expect(messageFor(new Error('No credentials for provider openai-codex.'))).toBe(
      'No credentials for provider openai-codex.'
    )
  })
})

describe('what never reaches the pane', () => {
  it('leaves a provider payload behind, lifting out only its sentence', () => {
    const message = messageFor(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"You\'re out of extra usage. Add more at claude.ai/settings/usage and keep going."},"request_id":"req_011CeAV1UmHy2dgWny5Qq66M"}'
    )

    expect(message).toBe(
      "You're out of extra usage. Add more at claude.ai/settings/usage and keep going."
    )
    expect(message).not.toContain('request_id')
    expect(message).not.toContain('{')
  })

  it('says nothing at all when the payload hides no sentence', () => {
    expect(messageFor('500 {"code":17,"request_id":"req-secret-diagnostic"}')).toBe(
      'The agent failed without saying why.'
    )
    expect(messageFor('502 <html><body>Bad gateway</body></html>')).toBe(
      'The agent failed without saying why.'
    )
  })

  it('drops a stack rather than printing it', () => {
    const thrown = new Error('boom\n    at openSession (/Users/someone/repos/crucible/src.ts:12:3)')

    expect(messageFor(thrown)).toBe('The agent failed without saying why.')
  })

  it('never stringifies an SDK error object it was handed', () => {
    const sdkError = { stopReason: 'error', errorMessage: 'nope', usage: { cost: 0.02 } }

    expect(messageFor(sdkError)).toBe('The agent failed without saying why.')
  })

  it('drops text too long for an error line instead of truncating a payload', () => {
    expect(messageFor(`Overloaded. ${'x'.repeat(400)}`)).toBe('The agent failed without saying why.')
  })
})

describe('the fallback', () => {
  it('is what a caller with better words to offer supplies', () => {
    expect(messageFor(undefined, 'The agent stopped before it finished.')).toBe(
      'The agent stopped before it finished.'
    )
    expect(messageFor('   ', 'The agent stopped before it finished.')).toBe(
      'The agent stopped before it finished.'
    )
  })

  it('does not displace something the provider did say', () => {
    expect(messageFor('Overloaded.', 'The agent stopped before it finished.')).toBe('Overloaded.')
  })
})
