#!/usr/bin/env bash
# Idempotent dependency setup for the Murmur monorepo (desktop + android).
# Runs during Cloud Agent environment install; safe to run repeatedly.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# --- Desktop (Electron) dependencies -----------------------------------------
# Lockfiles live per package (there is no root lockfile).
npm --prefix apps/desktop ci
npm --prefix packages/text-engine ci
npm --prefix packages/backend ci

# --- Android SDK -------------------------------------------------------------
# The Android app builds with AGP 8.13 / compileSdk 36 via the Gradle wrapper.
# Install the command-line tools and the SDK packages Gradle needs.
export ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
CMDLINE_BIN="$ANDROID_HOME/cmdline-tools/latest/bin"

if [ ! -x "$CMDLINE_BIN/sdkmanager" ]; then
  echo "Installing Android command-line tools into $ANDROID_HOME ..."
  mkdir -p "$ANDROID_HOME/cmdline-tools"
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/clt.zip" \
    "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
  unzip -q "$tmp/clt.zip" -d "$tmp"
  rm -rf "$ANDROID_HOME/cmdline-tools/latest"
  mv "$tmp/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
  rm -rf "$tmp"
fi

# `yes` receives SIGPIPE once sdkmanager stops reading; disable pipefail around
# it so that harmless signal is not treated as an error. sdkmanager's own exit
# status is still checked (it is the last command, so set -e catches failures).
set +o pipefail
yes | "$CMDLINE_BIN/sdkmanager" --sdk_root="$ANDROID_HOME" --licenses >/dev/null
set -o pipefail
"$CMDLINE_BIN/sdkmanager" --sdk_root="$ANDROID_HOME" \
  "platform-tools" "platforms;android-36" "build-tools;36.0.0" >/dev/null

# Point Gradle at the SDK (local.properties is gitignored).
printf 'sdk.dir=%s\n' "$ANDROID_HOME" > apps/android/local.properties

echo "Murmur setup complete (desktop deps + Android SDK at $ANDROID_HOME)."
