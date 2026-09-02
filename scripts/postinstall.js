// What npm runs after installing this package. Two lines of decision and no
// more: everything the desktop install does lives in the assembler the build
// emits. A repo checkout — told apart by its `src/`, which the published
// tarball lacks — does nothing at all, so `npm ci` in this repository never
// installs anything to anybody's machine and never needs `out/` to exist.

const { existsSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')

if (!existsSync(join(root, 'src'))) {
  require(join(root, 'out', 'main', 'postinstall.js'))
}
