#!/usr/bin/env bash
set -euo pipefail

REPO="${PI_CLOUD_REPO:-WSXYT/pi-cloud-computing}"
PACKAGE="github:${REPO}"
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
    PACKAGE="github:${REPO}"
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

if ! command -v node >/dev/null 2>&1; then
  install_node24
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" != "24" ]; then
  printf 'Node.js 24 is required; found %s. Installing Node.js 24...\n' "$(node --version)"
  install_node24
fi
if ! command -v npm >/dev/null 2>&1; then
  printf '%s\n' 'npm was not installed with Node.js 24.' >&2
  exit 1
fi

if ! command -v pi >/dev/null 2>&1; then
  npm install --global '@earendil-works/pi-coding-agent@0.84.2'
fi
npm install --global "$PACKAGE"

if [ "$MODE" = "client" ]; then
  pi install "$PACKAGE"
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

INSTALL_OUTPUT="$(pi-cloud worker install --ip "$IP" --systemd)"
DATA_DIR="${PI_CLOUD_DATA_DIR:-$HOME/.pi-cloud}"
UNIT="$DATA_DIR/pi-cloud-worker.service"
sudo install -D -m 0644 "$UNIT" /etc/systemd/system/pi-cloud-worker.service
sudo systemctl daemon-reload
sudo systemctl enable --now pi-cloud-worker.service
printf '%s\n' "$INSTALL_OUTPUT"
printf '%s\n' '' 'Worker installed and started.' 'Copy the printed fingerprint and pairing-code to the local Pi client.'
