import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'

// `crucible` on every agent's PATH. An agent's bash inherits main's
// environment, so a directory of Crucible's own at the front of main's PATH
// is how `crucible rules explain …` reaches this build's runner, whichever
// build it is: the installed app's, or a dev launch's out/ folder.

export interface ShimTarget {
  /** Electron's own binary, which runs the runner as plain Node. */
  readonly execPath: string
  /** The built runner: out/main/rules-cli.js. */
  readonly script: string
  readonly libDir: string
  readonly stateDir: string
}

function quoted(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

export function shimText(target: ShimTarget, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return [
      '@echo off',
      'set ELECTRON_RUN_AS_NODE=1',
      `set "CRUCIBLE_RULE_LIB=${target.libDir}"`,
      `set "CRUCIBLE_STATE_DIR=${target.stateDir}"`,
      `"${target.execPath}" "${target.script}" %*`,
      ''
    ].join('\r\n')
  }
  return [
    '#!/bin/sh',
    `ELECTRON_RUN_AS_NODE=1 CRUCIBLE_RULE_LIB=${quoted(target.libDir)} CRUCIBLE_STATE_DIR=${quoted(target.stateDir)} \\`,
    `  exec ${quoted(target.execPath)} ${quoted(target.script)} "$@"`,
    ''
  ].join('\n')
}

/** Writes the shim into `binDir` and puts that directory first on PATH. */
export function installCrucibleCommand(
  binDir: string,
  target: ShimTarget,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): void {
  mkdirSync(binDir, { recursive: true })
  const file = join(binDir, platform === 'win32' ? 'crucible.cmd' : 'crucible')
  writeFileSync(file, shimText(target, platform), 'utf8')
  if (platform !== 'win32') chmodSync(file, 0o755)
  const path = env.PATH ?? ''
  if (!path.split(delimiter).includes(binDir)) env.PATH = path === '' ? binDir : `${binDir}${delimiter}${path}`
}
