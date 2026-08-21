#!/bin/bash
# The vite dev-server port for THIS checkout, derived from its debug port.
#
# electron-vite points the window at the port it was *configured* with, not the
# one vite settled on after finding that port busy. So a second checkout
# launching against an occupied 5173 gets a window showing the first
# checkout's renderer: the app under test is not the code under test, and
# nothing says so. One port per checkout, pinned (`strictPort`), removes that.
#
# 5222-5292, mirroring the 9222-9292 debug ports one for one, so the two never
# drift and CRUCIBLE_DEBUG_PORT moves both.
set -euo pipefail

echo $(($(bash "$(dirname "$0")/dev-port.sh") - 4000))
