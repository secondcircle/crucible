#!/bin/bash
# Builds the current checkout and installs it as /Applications/Crucible.app —
# the stable app in the human's Dock.
#
# Stable means main: the script refuses any other branch and refuses a dirty
# tree, so the installed app is always a commit that exists on main, stamped
# below with which one. Dev launches are untouched by this; their state lives
# in Crucible-Dev (see src/main/index.ts).
set -euo pipefail
cd "$(dirname "$0")/.."

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "main" ]; then
  echo "install-stable: refusing to install from '$branch' — the installed app is built from main." >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "install-stable: refusing a dirty tree — commit or stash first, so the stamp names a real commit." >&2
  exit 1
fi

commit="$(git rev-parse --short HEAD)"

npm run build

# The stamp rides inside out/, so it is packaged with the build it describes.
node -e "
  require('fs').writeFileSync('out/build-stamp.json', JSON.stringify({
    commit: '$commit',
    builtAt: new Date().toISOString()
  }, null, 2) + '\n')
"

npx electron-builder --mac --dir --config electron-builder.yml

app="$(ls -d dist/mac*/Crucible.app | head -1)"
# Replace the bundle's contents, never the bundle directory itself. Removing
# the top-level .app needs write permission on /Applications (root:admin under
# MDM), and when that rm failed it had already emptied the bundle — a running
# app with nothing left on disk to relaunch. The user owns the .app directory,
# so clearing inside it and copying into it needs no admin at all.
rm -rf /Applications/Crucible.app/Contents
ditto "$app" /Applications/Crucible.app

echo
echo "Installed /Applications/Crucible.app from main @ $commit."
echo "If it is running, quit and relaunch to pick this build up."
