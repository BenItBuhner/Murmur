#!/usr/bin/env bash
# Per-boot startup for the Murmur monorepo.
# Provides a headless X display (:99) so the Electron desktop app can run.
# Run desktop GUI commands with the DISPLAY prefix, e.g.:
#   DISPLAY=:99 npm --prefix apps/desktop run dev
set -euo pipefail

# The X socket exists only while a server is listening on :99 — a reliable
# liveness check (unlike a name match, which can catch unrelated processes).
if [ -S /tmp/.X11-unix/X99 ]; then
  echo "Xvfb already running on :99"
else
  rm -f /tmp/.X99-lock
  # setsid detaches Xvfb into its own session so it survives this start
  # script exiting (the start command is run detached and then reaped).
  setsid Xvfb :99 -screen 0 1400x900x24 -ac +extension GLX +render -noreset \
    </dev/null >/tmp/xvfb.log 2>&1 &
  # Wait briefly for the display to come up so GUI commands can rely on it.
  for _ in $(seq 1 25); do
    [ -S /tmp/.X11-unix/X99 ] && break
    sleep 0.2
  done
  if [ -S /tmp/.X11-unix/X99 ]; then
    echo "Started Xvfb on :99"
  else
    echo "Failed to start Xvfb on :99; see /tmp/xvfb.log" >&2
    exit 1
  fi
fi
