#!/bin/bash
# The vite dev-server port for THIS checkout: the debug port minus 4000, so
# 5222-5292 mirrors 9222-9292 one for one and CRUCIBLE_DEBUG_PORT moves both.
#
# Per-checkout because vite slides off a busy 5173 to the next free port while
# electron-vite still points the window at 5173, and the window then quietly
# shows another checkout's renderer.
set -euo pipefail

echo $(($(bash "$(dirname "$0")/dev-port.sh") - 4000))
