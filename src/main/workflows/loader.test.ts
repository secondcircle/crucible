// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HostChild, SpawnHost } from './host/host'
import { createWorkflowLoader, type WorkflowLoader } from './loader'
import { AUTHORING_MODULE as AUTHORING, forkHost } from './testing/host-fork'

// Real files loaded through the real host: a forked process running the real
// entry, aliased to the real shipped authoring module. What passes here is
// what a workflow author gets.

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

function loaderOver(user: string, broken?: string[], spawn: SpawnHost = forkHost): WorkflowLoader {
  return createWorkflowLoader({
    roots: { user },
    authoringModule: AUTHORING,
    spawn,
    onUnloadable: (path) => broken?.push(path)
  })
}

/** The real spawn, counted: how many processes a loader started. */
function countingSpawn(): SpawnHost & { readonly started: string[] } {
  const started: string[] = []
  const spawn: SpawnHost = (file, authoring): HostChild => {
    started.push(file)
    return forkHost(file, authoring)
  }
  return Object.assign(spawn, { started })
}

describe('workflow loader', () => {
  it('discovers across both origins and loads real TypeScript', async () => {
    const user = tempDir()
    const workspace = tempDir()
    workflowFile(user, 'adhoc', 'the user one')
    workflowFile(join(workspace, '.crucible', 'workflows'), 'deploy', 'the workspace one')

    const loader = loaderOver(user)
    const listed = await loader.list(workspace)
    expect(listed.map((workflow) => [workflow.name, workflow.origin])).toEqual([
      ['adhoc', 'user'],
      ['deploy', 'workspace']
    ])
    expect(listed[1].manifest.description).toBe('the workspace one')
  })

  // Reading a manifest starts a host and runs the file's module body in it,
  // so an origin the caller will discard must cost no process at all: the
  // scheduler asks every 30 seconds and wants workspace files only.
  it('starts no process for an origin the caller did not ask for', async () => {
    const user = tempDir()
    const workspace = tempDir()
    workflowFile(user, 'adhoc', 'the user one')
    workflowFile(join(workspace, '.crucible', 'workflows'), 'deploy', 'the workspace one')

    const spawn = countingSpawn()
    const listed = await loaderOver(user, undefined, spawn).list(workspace, 'workspace')

    expect(listed.map((workflow) => workflow.name)).toEqual(['deploy'])
    expect(spawn.started).toEqual([join(workspace, '.crucible', 'workflows', 'deploy.ts')])
  })

  it('lets workspace shadow user', async () => {
    const user = tempDir()
    const workspace = tempDir()
    workflowFile(user, 'build', 'the user copy')
    workflowFile(join(workspace, '.crucible', 'workflows'), 'build', 'the workspace copy')

    const resolved = await loaderOver(user).resolve(workspace, 'build')
    expect(resolved.origin).toBe('workspace')
    expect(resolved.manifest.description).toBe('the workspace copy')
  })

  it('names the known workflows when asked for one that is not there', async () => {
    const user = tempDir()
    workflowFile(user, 'adhoc', 'the user one')
    await expect(loaderOver(user).resolve(tempDir(), 'bulid')).rejects.toThrow(
      /No workflow is named "bulid".*adhoc/
    )
  })

  it('skips a broken file in list and reports it, but throws from resolve', async () => {
    const user = tempDir()
    workflowFile(user, 'adhoc', 'fine')
    writeFileSync(join(user, 'cursed.ts'), 'export default {] this is not TypeScript', 'utf8')

    const broken: string[] = []
    const loader = loaderOver(user, broken)
    const listed = await loader.list(tempDir())
    expect(listed.map((workflow) => workflow.name)).toEqual(['adhoc'])
    expect(broken).toHaveLength(1)
    await expect(loader.resolve(tempDir(), 'cursed')).rejects.toThrow(/cursed/)
  })

  it('refuses a file that is not a workflow definition', async () => {
    const user = tempDir()
    writeFileSync(join(user, 'empty.ts'), 'export default {}\n', 'utf8')
    await expect(loaderOver(user).resolve(tempDir(), 'empty')).rejects.toThrow(
      /no description/
    )
  })

  // A schedule changes nothing about what a workflow is: the loader neither
  // requires the field nor validates it, so a schedule can never stop its
  // workflow being listed or run by hand.
  it('loads a definition with a schedule exactly as one without', async () => {
    const workspace = tempDir()
    const folder = join(workspace, '.crucible', 'workflows')
    mkdirSync(folder, { recursive: true })
    writeFileSync(
      join(folder, 'triage.ts'),
      `import { workflow } from 'crucible:workflow'\n` +
        `export default workflow({\n` +
        `  description: 'label untriaged issues',\n` +
        `  inputs: {},\n` +
        `  schedule: { cron: '0 9 * * *', check: () => true },\n` +
        `  run: async () => {}\n` +
        `})\n`,
      'utf8'
    )

    const loader = loaderOver(tempDir())
    const listed = await loader.list(workspace)
    expect(listed.map((workflow) => workflow.name)).toEqual(['triage'])

    const resolved = await loader.resolve(workspace, 'triage')
    expect(resolved.manifest.schedule?.cron).toBe('0 9 * * *')
    expect(resolved.manifest.description).toBe('label untriaged issues')

    // And a nonsense schedule is still a loadable workflow: what it cannot do
    // is fire, which the board says and the loader does not.
    writeFileSync(
      join(folder, 'odd.ts'),
      `import { workflow } from 'crucible:workflow'\n` +
        `export default workflow({\n` +
        `  description: 'a schedule nothing can fire',\n` +
        `  inputs: {},\n` +
        `  schedule: { cron: 'every morning' },\n` +
        `  run: async () => {}\n` +
        `})\n`,
      'utf8'
    )
    expect((await loader.list(workspace)).map((workflow) => workflow.name)).toEqual([
      'odd',
      'triage'
    ])
  })

  it('sees an edit on the very next resolve', async () => {
    const user = tempDir()
    workflowFile(user, 'adhoc', 'first wording')
    const loader = loaderOver(user)
    expect((await loader.resolve(tempDir(), 'adhoc')).manifest.description).toBe('first wording')

    workflowFile(user, 'adhoc', 'second wording')
    expect((await loader.resolve(tempDir(), 'adhoc')).manifest.description).toBe('second wording')
  })

  // A manifest costs a process, so the same bytes are not read twice; a run
  // is a process of its own regardless, opened from the loaded workflow.
  it('starts one process per distinct file for manifests, and one more per open()', async () => {
    const user = tempDir()
    workflowFile(user, 'adhoc', 'wording')
    const spawn = countingSpawn()
    const loader = loaderOver(user, undefined, spawn)

    await loader.list(tempDir())
    await loader.list(tempDir())
    const resolved = await loader.resolve(tempDir(), 'adhoc')
    expect(spawn.started).toHaveLength(1)

    const host = resolved.open()
    try {
      expect((await host.manifest()).description).toBe('wording')
    } finally {
      host.kill()
    }
    expect(spawn.started).toHaveLength(2)

    workflowFile(user, 'adhoc', 'rewording')
    expect((await loader.resolve(tempDir(), 'adhoc')).manifest.description).toBe('rewording')
    expect(spawn.started).toHaveLength(3)
  })
})
