#!/usr/bin/env bash
# Install the current stable Murmur build for this machine.
# Safe to pipe: curl -fsSL https://github.com/<repo>/releases/latest/download/install.sh | bash
set -euo pipefail

REPO="${MURMUR_REPO:-BenItBuhner/voxflow}"
BASE="${MURMUR_DOWNLOAD_BASE:-https://github.com/${REPO}/releases/latest/download}"
WANT_DEB=0
WANT_ANDROID=0
WANT_PORTABLE=0
DEST="${MURMUR_INSTALL_DIR:-}"
PRINT_URL=0

usage() {
  cat <<EOF
Install Murmur from the latest GitHub release.

Usage: install.sh [--deb] [--android] [--portable] [--dir DIR] [--print-url] [--help]

  --deb         Linux: install the .deb with apt/dpkg instead of the AppImage
  --android     Download the APK (does not adb-install)
  --portable    Windows (Git Bash): download the portable .exe instead of the installer
  --dir DIR     Where to place the AppImage / APK / portable exe
  --print-url   Print the download URL and exit
  --help        Show this help

Environment:
  MURMUR_REPO           owner/name (default: ${REPO})
  MURMUR_DOWNLOAD_BASE  override the download prefix
  MURMUR_INSTALL_DIR    default --dir
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --deb) WANT_DEB=1 ;;
    --android) WANT_ANDROID=1 ;;
    --portable) WANT_PORTABLE=1 ;;
    --dir)
      DEST="${2:-}"
      [ -n "$DEST" ] || { echo "error: --dir needs a path" >&2; exit 2; }
      shift
      ;;
    --print-url) PRINT_URL=1 ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown option $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

os="$(uname -s)"
arch="$(uname -m)"

asset=""
kind=""
case "$WANT_ANDROID" in
  1)
    asset="Murmur-android.apk"
    kind="android"
    ;;
  *)
    case "$os" in
      Linux)
        case "$arch" in
          x86_64|amd64)
            if [ "$WANT_DEB" -eq 1 ]; then
              asset="murmur_amd64.deb"
              kind="deb"
            else
              asset="Murmur-x86_64.AppImage"
              kind="appimage"
            fi
            ;;
          aarch64|arm64)
            if [ "$WANT_DEB" -eq 1 ]; then
              asset="murmur_arm64.deb"
              kind="deb"
            else
              asset="Murmur-arm64.AppImage"
              kind="appimage"
            fi
            ;;
          *)
            echo "error: unsupported Linux architecture: $arch" >&2
            exit 1
            ;;
        esac
        ;;
      Darwin)
        case "$arch" in
          arm64) asset="Murmur-arm64.zip" ;;
          x86_64) asset="Murmur-x64.zip" ;;
          *)
            echo "error: unsupported macOS architecture: $arch" >&2
            exit 1
            ;;
        esac
        kind="macos"
        ;;
      MINGW*|MSYS*|CYGWIN*)
        if [ "$WANT_PORTABLE" -eq 1 ]; then
          asset="Murmur-portable.exe"
          kind="win-portable"
        else
          asset="Murmur-setup.exe"
          kind="win-setup"
        fi
        ;;
      *)
        echo "error: unsupported OS: $os" >&2
        exit 1
        ;;
    esac
    ;;
esac

url="${BASE}/${asset}"
if [ "$PRINT_URL" -eq 1 ]; then
  printf '%s\n' "$url"
  exit 0
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "error: curl is required" >&2
  exit 1
fi

tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/murmur-install.XXXXXX")"
cleanup() { rm -rf "$tmpdir"; }
trap cleanup EXIT

echo "Downloading ${url}"
curl -fL --retry 3 --retry-delay 1 -o "${tmpdir}/${asset}" "$url"

sums_ok=0
if curl -fL --retry 2 -o "${tmpdir}/SHA256SUMS.txt" "${BASE}/SHA256SUMS.txt"; then
  line="$(grep -E "  ${asset}\$" "${tmpdir}/SHA256SUMS.txt" || true)"
  if [ -n "$line" ]; then
    printf '%s\n' "$line" > "${tmpdir}/SHA256.one"
    if command -v sha256sum >/dev/null 2>&1; then
      (cd "$tmpdir" && sha256sum -c SHA256.one)
      sums_ok=1
    elif command -v shasum >/dev/null 2>&1; then
      (cd "$tmpdir" && shasum -a 256 -c SHA256.one)
      sums_ok=1
    fi
  fi
fi
if [ "$sums_ok" -eq 0 ]; then
  echo "warning: could not verify SHA-256 for ${asset}; continuing" >&2
fi

install_file() {
  local src="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  if ! cp "$src" "$dest" 2>/dev/null; then
    echo "error: cannot write $dest" >&2
    exit 1
  fi
}

case "$kind" in
  appimage)
    dest="${DEST:-${HOME}/.local/bin/murmur}"
    install_file "${tmpdir}/${asset}" "$dest"
    chmod +x "$dest"
    echo "Installed AppImage to ${dest}"
    case ":${PATH}:" in
      *":$(dirname "$dest"):"*) ;;
      *) echo "Add $(dirname "$dest") to PATH to run \`murmur\` from any directory." ;;
    esac
    ;;
  deb)
    echo "Installing ${asset} with dpkg/apt (needs sudo)"
    if command -v apt-get >/dev/null 2>&1; then
      sudo apt-get install -y "${tmpdir}/${asset}"
    else
      sudo dpkg -i "${tmpdir}/${asset}"
    fi
    echo "Installed the Murmur .deb"
    ;;
  macos)
    dest="${DEST:-/Applications/Murmur.app}"
    if [ ! -w "$(dirname "$dest")" ]; then
      dest="${HOME}/Applications/Murmur.app"
    fi
    mkdir -p "$(dirname "$dest")"
    rm -rf "$dest"
    unzip -q "${tmpdir}/${asset}" -d "$tmpdir/extracted"
    app="$(find "$tmpdir/extracted" -name 'Murmur.app' -type d -print -quit || true)"
    if [ -z "$app" ]; then
      echo "error: Murmur.app missing from ${asset}" >&2
      exit 1
    fi
    cp -R "$app" "$dest"
    xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true
    echo "Installed ${dest}"
    echo "Grant Microphone and Accessibility access on first launch."
    ;;
  android)
    dest="${DEST:-${HOME}/Downloads/${asset}}"
    install_file "${tmpdir}/${asset}" "$dest"
    echo "Saved APK to ${dest}"
    echo "Open it on the device (or adb install) and finish the in-app setup."
    ;;
  win-setup)
    dest="${DEST:-${TMPDIR:-/tmp}/${asset}}"
    install_file "${tmpdir}/${asset}" "$dest"
    echo "Launching ${dest}"
    cmd.exe /c start "" "$(cygpath -w "$dest" 2>/dev/null || echo "$dest")"
    ;;
  win-portable)
    dest="${DEST:-${HOME}/Murmur/${asset}}"
    install_file "${tmpdir}/${asset}" "$dest"
    echo "Saved portable build to ${dest}"
    ;;
  *)
    echo "error: internal install kind: $kind" >&2
    exit 1
    ;;
esac
