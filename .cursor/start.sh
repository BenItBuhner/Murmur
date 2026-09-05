#!/usr/bin/env bash
# Per-boot startup for the Murmur monorepo.
# Provides a headless X display (:99) so the Electron desktop app can run.
# Run desktop GUI commands with the DISPLAY prefix, e.g.:
#   DISPLAY=:99 npm --prefix apps/desktop run dev
set -euo pipefail

if pgrep -f "Xvfb :99" >/dev/null 2>&1; then
  echo "Xvfb already running on :99"
else
  rm -f /tmp/.X99-lock
  Xvfb :99 -screen 0 1400x900x24 -ac +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &
  echo "Started Xvfb on :99"
fi
