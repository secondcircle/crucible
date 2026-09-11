// @vitest-environment node
//
// Driven against the real fake adapter, the real questions model and a real
// store, with no Electron and no IPC: the ask tool, the line and the answer
// batch's road to the agent, end to end.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFakeAdapter } from '../../shared/agent/fake-adapter'
import { ASK_TOOL, type AskRequest } from '../../shared/agent/ask-tool'
import type { PortEvent, Question, SessionId } from '../../shared/agent/port'
import { isAnswerBatch } from '../../shared/questions/wording'
import { createPanelModel } from '../panel/model'
import { storePanelPersistence } from '../panel/store-persistence'
import { createQuestionsModel, type QuestionsModel } from '../questions/model'
import { createShell, type Shell } from './shell'
import { createShellStore } from './store'

const WORKSPACE = '/repos/crucible'

const FIRST: AskRequest = {
  question: 'Where should the OpenAI API key come from?',
  context: 'OpenAI has no OAuth sign-in, and Crucible stores no provider secret today.',
  recommendation: 'Read OPENAI_ADMIN_KEY from the environment for now.'
}

const SECOND: AskRequest = {
  question: 'Should the merge gate block on a missing changelog entry?',
  context: 'CONTRIBUTING asks for a changelog line; nothing enforces it.',
  recommendation: 'Block. A gate that reports but never blocks teaches nobody.'
}

let directory: string
let shell: Shell
let questions: QuestionsModel
let events: PortEvent[]

// A slow beat is how a test keeps the scripted turn alive long enough to
// answer during it, which is the whole case the dock exists for.
function build(pauseMs = 0): void {
  const store = createShellStore(join(directory, 'shell-state.json'))
  questions = createQuestionsModel()
  shell = createShell({
    store,
    panel: createPanelModel({ persistence: storePanelPersistence(store) }),
    questions,
    adapter: createFakeAdapter({ pauseMs, ask: questions }),
    flavor: 'fake',
    pickFolder: async () => WORKSPACE
  })
  shell.onEvent((event) => events.push(event))
}

async function withSession(): Promise<SessionId> {
  const workspaceId = await shell.addWorkspace()
  if (workspaceId === null) throw new Error('the picker was supposed to answer')
  return shell.createSession(workspaceId)
}

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function until(what: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await what())) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await settled()
  }
}

async function lineOf(sessionId: SessionId): Promise<readonly Question[]> {
  const snapshot = await shell.snapshot()
  const session = snapshot.sessions.find((one) => one.id === sessionId)
  return session?.questions?.open ?? []
}

const delivered = (): string[] =>
  events.filter((event) => event.type === 'user_message').map((event) => event.text)

async function working(sessionId: SessionId): Promise<boolean> {
  const snapshot = await shell.snapshot()
  return snapshot.sessions.find((one) => one.id === sessionId)?.working === true
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'crucible-questions-'))
  events = []
  build()
})

afterEach(() => {
  shell.dispose()
  rmSync(directory, { recursive: true, force: true })
})

describe('a question crossing the port', () => {
  it('rides the session it was asked in, and announces itself', async () => {
    const sessionId = await withSession()
    questions.ask(sessionId, FIRST)

    const open = await lineOf(sessionId)
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({ question: FIRST.question, context: FIRST.context })

    const announced = events.filter((event) => event.type === 'question_asked')
    expect(announced).toEqual([{ type: 'question_asked', sessionId, questionId: open[0].id }])
    // The snapshot carrying it goes out first, so a listener already holds it.
    const at = events.findIndex((event) => event.type === 'question_asked')
    expect(events[at - 1].type).toBe('state')
  })

  it('is absent from a session with nothing open, so the dock is not there', async () => {
    const sessionId = await withSession()
    const snapshot = await shell.snapshot()
    expect(snapshot.sessions.find((one) => one.id === sessionId)?.questions).toBeUndefined()
  })
})

describe('what the agent is told, and when', () => {
  it('hears nothing at all while a question of the line is still open', async () => {
    const sessionId = await withSession()
    questions.ask(sessionId, FIRST)
    questions.ask(sessionId, SECOND)
    const open = await lineOf(sessionId)

    await shell.replyToQuestion(sessionId, open[0].id, { kind: 'answered', text: 'the env var' })
    await settled()

    expect(delivered()).toEqual([])
    const snapshot = await shell.snapshot()
    expect(snapshot.sessions.find((one) => one.id === sessionId)?.questions).toMatchObject({
      held: 1
    })
  })

  it('hears one message with every question the moment the line empties', async () => {
    const sessionId = await withSession()
    questions.ask(sessionId, FIRST)
    questions.ask(sessionId, SECOND)
    const open = await lineOf(sessionId)

    await shell.replyToQuestion(sessionId, open[0].id, { kind: 'recommendation' })
    await shell.replyToQuestion(sessionId, open[1].id, { kind: 'dismissed' })
    await until(() => delivered().length > 0)

    const batches = delivered().filter(isAnswerBatch)
    expect(batches).toHaveLength(1)
    expect(batches[0]).toContain(FIRST.recommendation)
    expect(batches[0]).toContain(SECOND.question)
    expect(batches[0]).toMatch(/Dismissed with no answer/)
  })

  it('shows the batch as one amber row of Crucible\u2019s own, never a user\u2019s bubble', async () => {
    const sessionId = await withSession()
    questions.ask(sessionId, FIRST)
    await shell.replyToQuestion(sessionId, (await lineOf(sessionId))[0].id, {
      kind: 'answered',
      text: 'The env var is fine.'
    })
    await until(() => delivered().length > 0)

    const said = events.find((event) => event.type === 'user_message')
    expect(said?.type === 'user_message' && said.card).toMatchObject({
      badge: 'answers',
      tone: 'warn',
      title: FIRST.question,
      body: 'The env var is fine.'
    })
  })

  it('starts a turn with the batch when the agent has already stopped', async () => {
    const sessionId = await withSession()
    questions.ask(sessionId, FIRST)
    await shell.replyToQuestion(sessionId, (await lineOf(sessionId))[0].id, {
      kind: 'recommendation'
    })
    await until(() => events.some((event) => event.type === 'turn_started'))

    const snapshot = await shell.snapshot()
    expect(snapshot.sessions.find((one) => one.id === sessionId)?.working).toBe(true)
    expect(delivered().some(isAnswerBatch)).toBe(true)
  })

  it('steers the live turn when the agent is still working', async () => {
    shell.dispose()
    build(30)
    const sessionId = await withSession()
    await shell.prompt(sessionId, 'ask me 2')
    await until(async () => (await lineOf(sessionId)).length === 2)
    expect(await working(sessionId)).toBe(true)

    const open = await lineOf(sessionId)
    await shell.replyToQuestion(sessionId, open[0].id, { kind: 'recommendation' })
    await shell.replyToQuestion(sessionId, open[1].id, { kind: 'answered', text: 'Block it.' })
    await until(() => delivered().some(isAnswerBatch))

    // Steering, not a second turn: the turn that asked is the turn that hears.
    expect(events.filter((event) => event.type === 'turn_started')).toHaveLength(1)
  })

  it('refuses nothing and loses nothing when the session is gone', async () => {
    const sessionId = await withSession()
    questions.ask(sessionId, FIRST)
    const open = await lineOf(sessionId)
    await shell.removeSession(sessionId)

    await shell.replyToQuestion(sessionId, open[0].id, { kind: 'dismissed' })
    await settled()
    expect(delivered()).toEqual([])
  })
})

describe('the ask tool behind the fake adapter', () => {
  it('puts its questions in the dock and says so in the transcript', async () => {
    const sessionId = await withSession()
    await shell.prompt(sessionId, 'ask me 2')
    await until(async () => (await lineOf(sessionId)).length === 2)

    const calls = events.filter((event) => event.type === 'tool_started')
    expect(calls.map((event) => event.type === 'tool_started' && event.name)).toEqual([
      ASK_TOOL,
      ASK_TOOL
    ])
    const open = await lineOf(sessionId)
    expect(open[0].question).toBe(calls[0].type === 'tool_started' && calls[0].summary)
  })

  it('keeps working while the questions stand', async () => {
    shell.dispose()
    build(30)
    const sessionId = await withSession()
    await shell.prompt(sessionId, 'ask me')
    await until(async () => (await lineOf(sessionId)).length === 1)

    expect(await working(sessionId)).toBe(true)
  })
})

describe('a session whose conversation is replaced', () => {
  it('loses its open questions on a reset, and tells the surface', async () => {
    const sessionId = await withSession()
    questions.ask(sessionId, FIRST)
    await shell.resetSession(sessionId)

    expect(await lineOf(sessionId)).toEqual([])
    expect(delivered()).toEqual([])
  })
})
