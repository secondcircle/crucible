// @vitest-environment node
//
// What the scheduler is told the repository declares, read through the real
// loader over real files: the `schedule` field as an author writes it, and
// the boundary that keeps a user-level or built-in schedule out of it.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkflowLoader } from '../workflows/loader'
import { loaderSchedules } from './source'

const AUTHORING = join(__dirname, '..', '..', '..', 'resources', 'workflow-lib', 'workflow.ts')

const scratch: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crucible-schedules-'))
  scratch.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function write(folder: string, name: string, body: string): void {
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, `${name}.ts`), body, 'utf8')
}

/** A workflow file, with whatever the test wants beside its description. */
function workflowFile(folder: string, name: string, extra: string, inputs = '{}'): void {
  write(
    folder,
    name,
    `import { workflow } from 'crucible:workflow'\n` +
      `export default workflow({\n` +
      `  description: 'the ${name} workflow',\n` +
      `  inputs: ${inputs},\n` +
      `${extra}` +
      `  run: async () => {}\n` +
      `})\n`
  )
}

function reader(user: string) {
  return loaderSchedules(createWorkflowLoader({ roots: { user }, authoringModule: AUTHORING }))
}

describe('what the scheduler reads', () => {
  it('takes the cron and the check a repo workflow declares', async () => {
    const workspace = tempDir()
    workflowFile(
      join(workspace, '.crucible', 'workflows'),
      'triage',
      `  schedule: { cron: '0 9 * * *', check: () => true },\n`
    )

    const declared = await reader(tempDir())(workspace)

    expect(declared).toHaveLength(1)
    expect(declared[0]).toMatchObject({
      workflow: 'triage',
      description: 'the triage workflow',
      cron: '0 9 * * *',
      declaresInputs: false
    })
    expect(declared[0]?.check).toBeTypeOf('function')
    // The check is the file's own function, called with the workspace path
    // and nothing else.
    expect(await declared[0]?.check?.({ workspacePath: workspace })).toBe(true)
  })

  it('ignores a schedule on a user workflow', async () => {
    const user = tempDir()
    const workspace = tempDir()
    workflowFile(user, 'mine', `  schedule: { cron: '0 9 * * *' },\n`)
    workflowFile(join(workspace, '.crucible', 'workflows'), 'repo', `  schedule: { cron: '0 9 * * *' },\n`)

    const declared = await reader(user)(workspace)

    expect(declared.map((schedule) => schedule.workflow)).toEqual(['repo'])
  })

  // It never loads one either. A listing transforms every file it loads and
  // runs its module body, and this listing happens every 30 seconds in every
  // open workspace: a user workflow that can never fire on a clock should
  // cost nothing at all.
  it('does not even execute a user workflow file', async () => {
    const user = tempDir()
    const workspace = tempDir()
    const marker = join(tempDir(), 'ran')
    write(
      user,
      'heavy',
      `import { writeFileSync } from 'node:fs'\n` +
        `import { workflow } from 'crucible:workflow'\n` +
        `writeFileSync(${JSON.stringify(marker)}, 'the module body ran')\n` +
        `export default workflow({\n` +
        `  description: 'the heavy workflow',\n` +
        `  inputs: {},\n` +
        `  run: async () => {}\n` +
        `})\n`
    )
    workflowFile(join(workspace, '.crucible', 'workflows'), 'repo', `  schedule: { cron: '0 9 * * *' },\n`)

    const declared = await reader(user)(workspace)

    expect(declared.map((schedule) => schedule.workflow)).toEqual(['repo'])
    expect(existsSync(marker)).toBe(false)
  })

  it('says a workflow declares inputs, which a scheduled fire cannot supply', async () => {
    const workspace = tempDir()
    workflowFile(
      join(workspace, '.crucible', 'workflows'),
      'needy',
      `  schedule: { cron: '0 9 * * *' },\n`,
      `{ intent: 'the intent document' }`
    )

    const declared = await reader(tempDir())(workspace)

    expect(declared[0]?.declaresInputs).toBe(true)
  })

  it('leaves a workflow with no schedule out of it entirely', async () => {
    const workspace = tempDir()
    workflowFile(join(workspace, '.crucible', 'workflows'), 'plain', '')

    expect(await reader(tempDir())(workspace)).toEqual([])
  })

  // A cron that is not even text is an expression nothing can fire, which the
  // board says rather than the listing throwing.
  it('passes a malformed cron through as an expression that cannot fire', async () => {
    const workspace = tempDir()
    workflowFile(
      join(workspace, '.crucible', 'workflows'),
      'wrong',
      `  schedule: { cron: 9 as unknown as string },\n`
    )

    const declared = await reader(tempDir())(workspace)

    expect(declared[0]?.cron).toBe('')
  })
})
