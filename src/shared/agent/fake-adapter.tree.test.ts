// @vitest-environment node
//
// The fake models the conversation as a tree of entries rather than a canned
// picture, so a jump really moves the position and what it leaves stays reachable.
import { describe, expect, it } from 'vitest'
import type { ConversationAdapter } from './adapter'
import { createFakeAdapter, FAKE_BRANCH_SUMMARY } from './fake-adapter'
import type { TreeNode } from './port'

const WORKSPACE = '/workspaces/crucible'

async function bound(): Promise<ConversationAdapter> {
  const adapter = createFakeAdapter({ pauseMs: 0 })
  await adapter.bind({ sessionId: 's1', workspacePath: WORKSPACE })
  return adapter
}

/** Every node text in the tree, depth first, which is creation order. */
function texts(nodes: readonly TreeNode[]): string[] {
  return nodes.flatMap((node) => [node.text, ...texts(node.children)])
}

async function said(adapter: ConversationAdapter, text: string): Promise<void> {
  await adapter.prompt('s1', `t-${text}`, text)
}

describe('the tree the fake serves', () => {
  it('is the user messages, in the order they were sent', async () => {
    const adapter = await bound()
    await said(adapter, 'first')
    await said(adapter, 'second')

    const tree = await adapter.sessionTree('s1')

    expect(texts(tree.roots)).toEqual(['first', 'second'])
    expect(tree.path).toHaveLength(2)
  })

  it('compresses what happened between two messages into one line', async () => {
    const adapter = await bound()
    await said(adapter, 'first')
    await said(adapter, 'second')

    const [root] = (await adapter.sessionTree('s1')).roots

    // Counted from the entries the scripted turn really produced.
    expect(root?.activity).toBe('thinking · assistant · 2 bash · 2 read')
  })

  it('says nothing about a message nothing has followed yet', async () => {
    const adapter = await bound()
    const running = adapter.prompt('s1', 't-1', 'first')

    const [root] = (await adapter.sessionTree('s1')).roots
    expect(root?.activity).toBeUndefined()

    await running
  })

  it('keeps a label with the conversation', async () => {
    const adapter = await bound()
    await said(adapter, 'first')
    const [root] = (await adapter.sessionTree('s1')).roots

    await adapter.setLabel('s1', root?.ref ?? '', ' checkpoint ')
    expect((await adapter.sessionTree('s1')).roots[0]?.label).toBe('checkpoint')

    await adapter.setLabel('s1', root?.ref ?? '')
    expect((await adapter.sessionTree('s1')).roots[0]?.label).toBeUndefined()
  })
})

describe('a jump', () => {
  it('moves the position back and hands the message to the composer', async () => {
    const adapter = await bound()
    await said(adapter, 'first')
    await said(adapter, 'second')
    const tree = await adapter.sessionTree('s1')
    const second = tree.roots[0]?.children[0]

    const jumped = await adapter.jump('s1', second?.ref ?? '', false)

    expect(jumped).toEqual({ cancelled: false, editorText: 'second' })
    const items = await adapter.transcript('s1')
    expect(items.filter((item) => item.kind === 'user')).toEqual([
      { kind: 'user', text: 'first' }
    ])
  })

  it('leaves the abandoned path in the tree, reachable', async () => {
    const adapter = await bound()
    await said(adapter, 'first')
    await said(adapter, 'second')
    const second = (await adapter.sessionTree('s1')).roots[0]?.children[0]
    await adapter.jump('s1', second?.ref ?? '', false)

    await said(adapter, 'third')
    const after = await adapter.sessionTree('s1')

    // Both children hang off the first message; only one is on the path.
    expect(texts(after.roots)).toEqual(['first', 'second', 'third'])
    expect(after.path).toHaveLength(2)
    expect(after.path.at(-1)).toBe(after.roots[0]?.children[1]?.ref)
  })

  it('leaves a summary behind when asked, and only then', async () => {
    const adapter = await bound()
    await said(adapter, 'first')
    await said(adapter, 'second')
    const second = (await adapter.sessionTree('s1')).roots[0]?.children[0]

    await adapter.jump('s1', second?.ref ?? '', true)

    const items = await adapter.transcript('s1')
    expect(items.at(-1)).toEqual({ kind: 'summary', text: FAKE_BRANCH_SUMMARY })
  })
})

describe('images', () => {
  it('round-trip through the transcript, and only when they were sent', async () => {
    const adapter = await bound()
    const images = [{ mimeType: 'image/png', data: 'AAAA' }]

    await adapter.prompt('s1', 't-1', 'what is this?', images)
    await adapter.prompt('s1', 't-2', 'and this one?')

    const items = await adapter.transcript('s1')
    expect(items.filter((item) => item.kind === 'user')).toEqual([
      { kind: 'user', text: 'what is this?', images },
      { kind: 'user', text: 'and this one?' }
    ])
  })
})

describe('sharing a bash run', () => {
  const RUN = { command: 'git status', output: 'clean\n', exitCode: 0 }

  it('says idle when no run is live', async () => {
    const adapter = await bound()

    await expect(adapter.shareBashRun('s1', RUN)).resolves.toBe('idle')
  })

  it('delivers at a scripted tool boundary during a live run', async () => {
    const adapter = await bound()
    const running = adapter.prompt('s1', 't-1', 'first')

    await expect(adapter.shareBashRun('s1', RUN)).resolves.toBe('delivered')
    await running

    const items = await adapter.transcript('s1')
    expect(items).toContainEqual({ kind: 'bashRun', ...RUN })
  })

  it('drops what a cancelled run never delivered', async () => {
    const adapter = await bound()
    const running = adapter.prompt('s1', 't-1', 'first')
    const share = adapter.shareBashRun('s1', RUN)

    await adapter.cancel('s1')
    await running

    await expect(share).resolves.toBe('dropped')
    const items = await adapter.transcript('s1')
    expect(items.some((item) => item.kind === 'bashRun')).toBe(false)
  })

  it('answers a run of its own when it is the whole turn', async () => {
    const adapter = await bound()

    await adapter.promptBashRun('s1', 't-1', RUN)

    const items = await adapter.transcript('s1')
    expect(items[0]).toEqual({ kind: 'bashRun', ...RUN })
    expect(items.some((item) => item.kind === 'user')).toBe(false)
  })
})
