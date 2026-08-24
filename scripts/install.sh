#!/usr/bin/env bash
set -euo pipefail

REPO="${PI_CLOUD_REPO:-WSXYT/pi-cloud-computing}"
MODE="client"
IP=""

while [ "$#" -gt 0 ]; do
  case "$1" in
  --worker) MODE="worker" ;;
  --ip)
    shift
    IP="${1:-}"
    ;;
  --repo)
    shift
    REPO="${1:-}"
    ;;
  -h | --help)
    printf '%s\n' 'Usage:' '  install.sh                 Install Pi Cloud client' '  install.sh --worker --ip IP  Install and enable a Linux systemd Worker' '  install.sh --repo OWNER/REPO'
    exit 0
    ;;
  *)
    printf 'Unknown option: %s\n' "$1" >&2
    exit 2
    ;;
  esac
  shift
done

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo"
fi

install_node24() {
  if ! command -v apt-get >/dev/null 2>&1; then
    printf '%s\n' 'Node.js 24 is required. Automatic installation currently supports Debian/Ubuntu apt systems.' >&2
    exit 1
  fi
  if [ "$(id -u)" -ne 0 ]; then
    SUDO=sudo
  else
    SUDO=
  fi
  $SUDO apt-get update
  $SUDO apt-get install -y ca-certificates curl gnupg
  if [ -n "$SUDO" ]; then
    curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  else
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  fi
  $SUDO apt-get install -y nodejs
}

NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ] || [ "$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')" != "24" ]; then
  install_node24
  hash -r
  NODE_BIN="/usr/bin/node"
fi
if [ ! -x "$NODE_BIN" ] || [ "$($NODE_BIN -p 'process.versions.node.split(".")[0]')" != "24" ]; then
  printf '%s\n' 'Node.js 24 installation did not become the active system Node.' >&2
  printf 'Found: %s\n' "${NODE_BIN:-none}" >&2
  exit 1
fi
NPM_BIN="$(dirname "$NODE_BIN")/npm"
if [ ! -x "$NPM_BIN" ]; then
  printf 'npm was not found beside %s.\n' "$NODE_BIN" >&2
  exit 1
fi
export PATH="$(dirname "$NODE_BIN"):$PATH"
printf 'Using Node %s and npm %s\n' "$($NODE_BIN --version)" "$($NPM_BIN --version)"

if ! command -v pi >/dev/null 2>&1; then
  "$NPM_BIN" install --global '@earendil-works/pi-coding-agent@0.84.2' --ignore-scripts
fi

SOURCE_DIR="${PI_CLOUD_SOURCE_DIR:-${PI_CLOUD_DATA_DIR:-$HOME/.pi-cloud}/source}"
if [ -d "$SOURCE_DIR/.git" ]; then
  git -C "$SOURCE_DIR" fetch --depth 1 origin main
  git -C "$SOURCE_DIR" reset --hard origin/main
else
  mkdir -p "$(dirname "$SOURCE_DIR")"
  git clone --depth 1 "https://github.com/$REPO.git" "$SOURCE_DIR"
fi
(
  cd "$SOURCE_DIR"
  "$NPM_BIN" ci --ignore-scripts
  "$NPM_BIN" run build
)

if [ "$MODE" = "client" ]; then
  pi install "$SOURCE_DIR"
  printf '%s\n' '' 'Pi Cloud client installed. Restart Pi or run /reload.' 'Next: /cloud-pair <https-url> <fingerprint> <pairing-code>'
  exit 0
fi

if [ "$(uname -s)" != "Linux" ]; then
  printf '%s\n' 'The Worker installer requires Linux and systemd.' >&2
  exit 1
fi
if [ -z "$IP" ]; then
  printf '%s\n' 'Usage: install.sh --worker --ip <public-vps-ip>' >&2
  exit 2
fi
if ! command -v systemctl >/dev/null 2>&1; then
  printf '%s\n' 'systemd is required for the Worker installer.' >&2
  exit 1
fi

CLI="$SOURCE_DIR/dist/src/cli.js"
INSTALL_OUTPUT="$("$NODE_BIN" "$CLI" worker install --ip "$IP" --systemd)"
DATA_DIR="${PI_CLOUD_DATA_DIR:-$HOME/.pi-cloud}"
UNIT="$DATA_DIR/pi-cloud-worker.service"
$SUDO install -D -m 0644 "$UNIT" /etc/systemd/system/pi-cloud-worker.service
$SUDO systemctl daemon-reload
$SUDO systemctl enable --now pi-cloud-worker.service
printf '%s\n' "$INSTALL_OUTPUT"
printf '%s\n' '' 'Worker installed and started.' 'Copy the printed fingerprint and pairing-code to the local Pi client.'
