# The worktree contract.
#
# A fresh checkout of this repository — typically a git worktree sitting next
# to the live checkout — is made development-ready by `make provision` and
# proves it with `make validate`. Those two targets are the whole interface;
# everything a run needs to know about building this repo is behind them.
#
#   make provision   idempotent; safe to run in a checkout that is already ready
#   make validate    exit 0 iff this checkout is development-ready
#
# Nothing here is per-machine: this repo's per-checkout state is `node_modules/`,
# `out/` and the `*.tsbuildinfo` files, all inside the checkout and all
# git-ignored, so two checkouts validate side by side without colliding. The
# fixed remote debugging port lives in `npm run dev` only, which validate never
# runs.

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

.PHONY: provision validate build

# Provisioning is dependency installation and nothing else — no local config
# file to write, no scratch directory to create, no port or database name to
# derive. Make's timestamp comparison is what makes the second run a no-op:
# `npm ci` runs only when the lockfile or manifest is newer than the tree it
# produced.
provision: node_modules

node_modules: package-lock.json package.json
	npm ci
	@touch node_modules

# validate is a fixpoint on checkout state — content *and* metadata. Once it
# has passed, running it again must leave every file and directory in the
# checkout untouched: same bytes, same mtimes. Two rules make that hold, and
# both live here, because this is the one place that decides how each leg of
# the bar is invoked:
#
#  1. A leg may persist a *result*, never a *measurement*. Vitest's cache
#     records each test's wall-clock duration, which differs on every run by
#     construction, so the test leg runs `--no-cache`.
#  2. A leg that *produces* something is expressed as a file target with its
#     inputs as prerequisites, so it is re-run when the inputs change and
#     skipped when they have not. Rewriting identical build output is the one
#     thing a re-run cannot do idempotently: `vite` truncates and rewrites
#     every file under `out/` (and drops a temporary bundled config beside the
#     Makefile), moving mtimes that make and every other incremental tool read.
#
# The *checking* legs — typecheck, lint, test — are never skipped: they write
# nothing anyone can observe, so caching them would only buy staleness. What is
# cached is the build, by make's ordinary up-to-date rule — and a cached leg
# may only report success on the strength of a record that *entails* what it
# stands for, which is why the build's record is a checksum manifest of its
# outputs rather than a bare marker (see `build` below).
#
# Recipe lines run in the order below, cheapest failure first; under
# `.SHELLFLAGS -e` each must exit 0 for the next to run.
validate:
	@test -d node_modules || { \
	  echo "node_modules/ is missing — run 'make provision' first." >&2; \
	  exit 1; \
	}
	npm run typecheck
	npm run lint
	npm test -- --no-cache
	$(MAKE) --no-print-directory build

# Every input the build reads. The `find` covers directories as well as files,
# so adding or deleting a source — which moves its directory's mtime — also
# invalidates the build, not just editing one.
BUILD_INPUTS := package.json package-lock.json electron.vite.config.ts \
  tsconfig.json tsconfig.node.json tsconfig.web.json \
  $(shell find src -type d) $(shell find src -type f)

# The entry points the build must produce, on the repository's own authority
# rather than a list invented here: `main` is where package.json points
# Electron, and the other two are the fixed places electron-vite writes the
# preload and renderer entries. A record of a build can only certify what it
# records — these are the facts it is checked *against*, so a record cannot
# certify a build that never produced them.
REQUIRED_OUTPUTS := $(shell node -p "require('./package.json').main" 2>/dev/null) \
  out/preload/index.js out/renderer/index.html

# The build leg. `out/.build-stamp` is not a bare marker: it is the sha256
# manifest of every file the build wrote, so "up to date" can mean the three
# things it has to mean — no input has moved, the entry points are there, and
# every output is still byte-for-byte what this build produced. Make decides
# only the first: it compares timestamps of the target it was asked for, and
# never learns that a file that target stands for was deleted or rewritten. The
# rest is decided here, before make is consulted, and a record that no longer
# holds invalidates itself — rebuilding is then make's ordinary business.
#
# The manifest is derived from what the build actually wrote, never from a list
# of names kept by hand: the renderer bundle's filename carries a content hash,
# so no fixed list could stay true.
build:
	@ok=1; \
	 shasum -a 256 -c out/.build-stamp >/dev/null 2>&1 || ok=0; \
	 for f in $(REQUIRED_OUTPUTS); do test -e "$$f" || ok=0; done; \
	 test "$$ok" = 1 || rm -f out/.build-stamp
	@$(MAKE) --no-print-directory out/.build-stamp

# `vite` empties `out/` on every build, so the stamp lives inside it: ignored
# with the artifacts it describes, and gone with them if `out/` is deleted. A
# build that somehow does not produce an entry point fails here rather than
# leaving a record that would be torn up and retried on every later run.
out/.build-stamp: node_modules $(BUILD_INPUTS)
	npm run build
	@for f in $(REQUIRED_OUTPUTS); do \
	  test -e "$$f" || { echo "build did not produce $$f" >&2; exit 1; }; \
	 done
	@find out -type f ! -name .build-stamp -print0 | sort -z | xargs -0 shasum -a 256 > $@
