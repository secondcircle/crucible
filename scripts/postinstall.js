// What npm runs after installing this package. Two lines of decision and no
// more: everything the desktop install does lives in the assembler, which the
// build emits beside the app it installs.
//
// A repo checkout is told apart by its `src/` — the published tarball has
// none — and does nothing at all, so `npm ci` in this repository never
// installs anything to anybody's machine, and never depends on `out/`
// existing yet either.

const { existsSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')

if (!existsSync(join(root, 'src'))) {
  require(join(root, 'out', 'main', 'postinstall.js'))
}
