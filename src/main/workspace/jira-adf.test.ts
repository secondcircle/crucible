// @vitest-environment node
//
// ADF in, markdown out. Pure, so every node type is checkable on its own.
import { describe, expect, it } from 'vitest'
import { adfToMarkdown } from './jira-adf'

const doc = (...content: unknown[]): unknown => ({ type: 'doc', version: 1, content })

const text = (value: string, marks?: unknown[]): unknown => ({
  type: 'text',
  text: value,
  ...(marks === undefined ? {} : { marks })
})

const para = (...content: unknown[]): unknown => ({ type: 'paragraph', content })

describe('the blocks', () => {
  it('turns paragraphs into paragraphs, one blank line apart', () => {
    expect(adfToMarkdown(doc(para(text('First.')), para(text('Second.'))))).toBe(
      'First.\n\nSecond.'
    )
  })

  it('turns a heading into hashes at its own level', () => {
    expect(
      adfToMarkdown(
        doc(
          { type: 'heading', attrs: { level: 2 }, content: [text('Steps')] },
          { type: 'heading', attrs: { level: 4 }, content: [text('Detail')] }
        )
      )
    ).toBe('## Steps\n\n#### Detail')
  })

  it('turns a bullet list into dashes, nesting with two spaces', () => {
    const nested = {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [para(text('one'))] },
        {
          type: 'listItem',
          content: [
            para(text('two')),
            { type: 'bulletList', content: [{ type: 'listItem', content: [para(text('inner'))] }] }
          ]
        }
      ]
    }

    expect(adfToMarkdown(doc(nested))).toBe('- one\n- two\n\n  - inner')
  })

  it('numbers an ordered list, from its own start', () => {
    const list = (attrs: unknown): unknown => ({
      type: 'orderedList',
      ...(attrs === undefined ? {} : { attrs }),
      content: [
        { type: 'listItem', content: [para(text('first'))] },
        { type: 'listItem', content: [para(text('second'))] }
      ]
    })

    expect(adfToMarkdown(doc(list(undefined)))).toBe('1. first\n2. second')
    expect(adfToMarkdown(doc(list({ order: 3 })))).toBe('3. first\n4. second')
  })

  it('fences a code block with its language', () => {
    expect(
      adfToMarkdown(
        doc({
          type: 'codeBlock',
          attrs: { language: 'sql' },
          content: [text('select 1')]
        })
      )
    ).toBe('```sql\nselect 1\n```')
    expect(adfToMarkdown(doc({ type: 'codeBlock', content: [text('plain')] }))).toBe(
      '```\nplain\n```'
    )
  })

  it('quotes a blockquote and rules a rule', () => {
    expect(
      adfToMarkdown(doc({ type: 'blockquote', content: [para(text('as agreed'))] }, { type: 'rule' }))
    ).toBe('> as agreed\n\n---')
  })

  it('names an attachment rather than pretending to show it', () => {
    expect(adfToMarkdown(doc({ type: 'mediaSingle', content: [{ type: 'media' }] }))).toBe(
      '_(attachment)_'
    )
  })
})

describe('the inline marks', () => {
  it('maps each one to its markdown, code innermost and the link outside all', () => {
    expect(adfToMarkdown(doc(para(text('bold', [{ type: 'strong' }]))))).toBe('**bold**')
    expect(adfToMarkdown(doc(para(text('slanted', [{ type: 'em' }]))))).toBe('*slanted*')
    expect(adfToMarkdown(doc(para(text('gone', [{ type: 'strike' }]))))).toBe('~~gone~~')
    expect(adfToMarkdown(doc(para(text('npm ci', [{ type: 'code' }]))))).toBe('`npm ci`')
    expect(
      adfToMarkdown(
        doc(
          para(
            text('the ticket', [
              { type: 'link', attrs: { href: 'https://x/browse/EK-1' } },
              { type: 'strong' }
            ])
          )
        )
      )
    ).toBe('[**the ticket**](https://x/browse/EK-1)')
  })

  it('leaves a mark it has no markdown for as plain text', () => {
    expect(adfToMarkdown(doc(para(text('underlined', [{ type: 'underline' }]))))).toBe('underlined')
  })

  it('breaks a line where the document breaks one', () => {
    expect(adfToMarkdown(doc(para(text('one'), { type: 'hardBreak' }, text('two'))))).toBe(
      'one\ntwo'
    )
  })

  it('reads a mention and an emoji as the text they carry', () => {
    expect(
      adfToMarkdown(
        doc(
          para(
            { type: 'mention', attrs: { id: '557058:x', text: '@Devi Raman' } },
            text(' please look'),
            { type: 'emoji', attrs: { shortName: ':eyes:', text: '👀' } }
          )
        )
      )
    ).toBe('@Devi Raman please look👀')
  })

  it('reads an inline card as its URL', () => {
    expect(
      adfToMarkdown(doc(para({ type: 'inlineCard', attrs: { url: 'https://x/browse/EK-9' } })))
    ).toBe('https://x/browse/EK-9')
  })
})

describe('what it does with a node it does not know', () => {
  it('keeps the text rather than dropping the block', () => {
    const panel = {
      type: 'panel',
      attrs: { panelType: 'warning' },
      content: [para(text('Do not deploy on a Friday.'))]
    }

    expect(adfToMarkdown(doc(panel))).toBe('Do not deploy on a Friday.')
  })

  it('flattens a table to the text of its cells', () => {
    const table = {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            { type: 'tableCell', content: [para(text('left'))] },
            { type: 'tableCell', content: [para(text('right'))] }
          ]
        }
      ]
    }

    expect(adfToMarkdown(doc(table))).toContain('left')
    expect(adfToMarkdown(doc(table))).toContain('right')
  })

  it('is the empty string for an absent or unrecognizable description', () => {
    // Which the reading pane already renders as "No description."
    for (const value of [undefined, null, '', 42, [], { type: 'doc' }]) {
      expect(adfToMarkdown(value)).toBe('')
    }
  })
})
