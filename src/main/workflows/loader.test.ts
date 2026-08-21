// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkflowLoader, type WorkflowLoader } from './loader'

// Real files loaded through the real jiti path, aliased to the real shipped
// authoring module: what passes here is what a workflow author gets.

const AUTHORING = join(__dirname, '..', '..', '..', 'resources', 'workflows', 'lib', 'workflow.ts')

const scratch: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crucible-workflows-'))
  scratch.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function workflowFile(folder: string, name: string, description: string): void {
  mkdirSync(folder, { recursive: true })
  writeFileSync(
    join(folder, `${name}.ts`),
    `import { workflow } from 'crucible:workflow'\n` +
      `export default workflow({\n` +
      `  description: '${description}',\n` +
      `  inputs: { prompt: 'a file' },\n` +
      `  run: async () => {}\n` +
      `})\n`,
    'utf8'
  )
}

function loaderOver(builtIn: string, user: string, broken?: string[]): WorkflowLoader {
  return createWorkflowLoader({
    roots: { builtIn, user },
    authoringModule: AUTHORING,
    onUnloadable: (path) => broken?.push(path)
  })
}

describe('workflow loader', () => {
  it('discovers across the three origins and loads real TypeScript', async () => {
    const builtIn = tempDir()
    const user = tempDir()
    const workspace = tempDir()
    workflowFile(builtIn, 'adhoc', 'the built-in one')
    workflowFile(join(workspace, '.crucible', 'workflows'), 'deploy', 'the workspace one')

    const loader = loaderOver(builtIn, user)
    const listed = await loader.list(workspace)
    expect(listed.map((workflow) => [workflow.name, workflow.origin])).toEqual([
      ['adhoc', 'built-in'],
      ['deploy', 'workspace']
    ])
    expect(listed[1].def.description).toBe('the workspace one')
  })

  it('lets workspace shadow user shadow built-in', async () => {
    const builtIn = tempDir()
    const user = tempDir()
    const workspace = tempDir()
    workflowFile(builtIn, 'build', 'shipped')
    workflowFile(user, 'build', 'the user copy')
    workflowFile(join(workspace, '.crucible', 'workflows'), 'build', 'the workspace copy')

    const resolved = await loaderOver(builtIn, user).resolve(workspace, 'build')
    expect(resolved.origin).toBe('workspace')
    expect(resolved.def.description).toBe('the workspace copy')
  })

  it('names the known workflows when asked for one that is not there', async () => {
    const builtIn = tempDir()
    workflowFile(builtIn, 'adhoc', 'shipped')
    await expect(loaderOver(builtIn, tempDir()).resolve(tempDir(), 'bulid')).rejects.toThrow(
      /No workflow is named "bulid".*adhoc/
    )
  })

  it('skips a broken file in list and reports it, but throws from resolve', async () => {
    const builtIn = tempDir()
    workflowFile(builtIn, 'adhoc', 'fine')
    writeFileSync(join(builtIn, 'cursed.ts'), 'export default {] this is not TypeScript', 'utf8')

    const broken: string[] = []
    const loader = loaderOver(builtIn, tempDir(), broken)
    const listed = await loader.list(tempDir())
    expect(listed.map((workflow) => workflow.name)).toEqual(['adhoc'])
    expect(broken).toHaveLength(1)
    await expect(loader.resolve(tempDir(), 'cursed')).rejects.toThrow(/cursed/)
  })

  it('refuses a file that is not a workflow definition', async () => {
    const builtIn = tempDir()
    writeFileSync(join(builtIn, 'empty.ts'), 'export default {}\n', 'utf8')
    await expect(loaderOver(builtIn, tempDir()).resolve(tempDir(), 'empty')).rejects.toThrow(
      /no description/
    )
  })

  it('sees an edit on the very next resolve', async () => {
    const builtIn = tempDir()
    workflowFile(builtIn, 'adhoc', 'first wording')
    const loader = loaderOver(builtIn, tempDir())
    expect((await loader.resolve(tempDir(), 'adhoc')).def.description).toBe('first wording')

    workflowFile(builtIn, 'adhoc', 'second wording')
    expect((await loader.resolve(tempDir(), 'adhoc')).def.description).toBe('second wording')
  })
})
