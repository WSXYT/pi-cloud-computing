#!/usr/bin/env bash
set -euo pipefail

REPO="${PI_CLOUD_REPO:-WSXYT/pi-cloud-computing}"
ROLE=""
LANGUAGE=""
IP=""
RUNNER=""
ASSUME_YES=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --client) ROLE="client" ;;
    --worker) ROLE="worker" ;;
    --both) ROLE="both" ;;
    --ip) shift; IP="${1:-}" ;;
    --lang|--language) shift; LANGUAGE="${1:-}" ;;
    --runner) shift; RUNNER="${1:-}" ;;
    --repo) shift; REPO="${1:-}" ;;
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help)
      printf '%s\n' \
        'Pi Cloud installer' \
        '  --client                 Install the local Pi extension' \
        '  --worker --ip ADDRESS    Install the Linux Worker' \
        '  --both --ip ADDRESS      Install both roles' \
        '  --lang zh-CN|en          Set interface language' \
        '  --runner host|docker     Set Worker isolation mode' \
        'Without role/language arguments, the installer asks interactively.'
      exit 0
      ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

ask() {
  local prompt="$1" default="$2" answer=""
  if [ "$ASSUME_YES" -eq 0 ] && [ -r /dev/tty ]; then
    printf '%s' "$prompt" >/dev/tty
    IFS= read -r answer </dev/tty || true
  fi
  printf '%s' "${answer:-$default}"
}

if [ -z "$LANGUAGE" ]; then
  default_language="en"
  case "${LC_ALL:-${LANG:-}}" in zh*|ZH*) default_language="zh-CN" ;; esac
  if [ "$default_language" = "zh-CN" ]; then default_choice=1; else default_choice=2; fi
  language_choice="$(ask $'选择语言 / Choose language:\n  1) 简体中文\n  2) English\n> ' "$default_choice")"
  if [ "$language_choice" = "1" ] || [ "$language_choice" = "zh-CN" ]; then LANGUAGE="zh-CN"; else LANGUAGE="en"; fi
fi
if [ "$LANGUAGE" != "zh-CN" ] && [ "$LANGUAGE" != "en" ]; then
  printf '%s\n' 'Language must be zh-CN or en.' >&2
  exit 2
fi

if [ -z "$ROLE" ]; then
  if [ "$LANGUAGE" = "zh-CN" ]; then
    role_choice="$(ask $'安装到哪里？\n  1) 本地电脑：Pi 插件\n  2) Linux VPS：云端 Worker\n  3) 两者都安装\n> ' 1)"
  else
    role_choice="$(ask $'What do you want to install?\n  1) Local computer: Pi extension\n  2) Linux VPS: cloud Worker\n  3) Both\n> ' 1)"
  fi
  case "$role_choice" in 2) ROLE="worker" ;; 3) ROLE="both" ;; *) ROLE="client" ;; esac
fi

if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi

install_node24() {
  if command -v apt-get >/dev/null 2>&1; then
    $SUDO apt-get update
    $SUDO apt-get install -y ca-certificates curl gnupg git
    if [ -n "$SUDO" ]; then curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -; else curl -fsSL https://deb.nodesource.com/setup_24.x | bash -; fi
    $SUDO apt-get install -y nodejs
    NODE_BIN="/usr/bin/node"
    return
  fi
  if [ "$(uname -s)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    brew install node@24 git
    NODE_BIN="$(brew --prefix node@24)/bin/node"
    return
  fi
  printf '%s\n' 'Node.js 24 is required. Install it and run this installer again.' >&2
  exit 1
}

NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ] || [ "$($NODE_BIN -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)" != "24" ]; then install_node24; fi
if [ ! -x "$NODE_BIN" ] || [ "$($NODE_BIN -p 'process.versions.node.split(".")[0]')" != "24" ]; then
  printf '%s\n' 'Node.js 24 installation did not become active.' >&2
  exit 1
fi
NPM_BIN="$(dirname "$NODE_BIN")/npm"
if [ ! -x "$NPM_BIN" ]; then printf 'npm was not found beside %s.\n' "$NODE_BIN" >&2; exit 1; fi
export PATH="$(dirname "$NODE_BIN"):$PATH"
printf 'Node %s · npm %s\n' "$($NODE_BIN --version)" "$($NPM_BIN --version)"

if ! command -v git >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then $SUDO apt-get install -y git; else printf '%s\n' 'Git is required.' >&2; exit 1; fi
fi

PI_BIN="$(command -v pi 2>/dev/null || true)"
if [ "$ROLE" = "worker" ] || [ "$ROLE" = "both" ]; then
  SYSTEM_PI="$(dirname "$NODE_BIN")/pi"
  if [ ! -x "$SYSTEM_PI" ]; then
    "$NPM_BIN" install --global '@earendil-works/pi-coding-agent@0.84.2' --ignore-scripts
  fi
  PI_BIN="$SYSTEM_PI"
  if [ "$LANGUAGE" = "zh-CN" ]; then printf 'Worker 使用系统 Pi：%s\n' "$PI_BIN"; else printf 'Worker will use system Pi: %s\n' "$PI_BIN"; fi
elif [ -z "$PI_BIN" ]; then
  "$NPM_BIN" install --global '@earendil-works/pi-coding-agent@0.84.2' --ignore-scripts
  hash -r
  PI_BIN="$(command -v pi)"
  if [ "$LANGUAGE" = "zh-CN" ]; then printf '已安装 Pi：%s\n' "$PI_BIN"; else printf 'Installed Pi: %s\n' "$PI_BIN"; fi
else
  if [ "$LANGUAGE" = "zh-CN" ]; then printf '检测到已有 Pi：%s，不重复安装。\n' "$PI_BIN"; else printf 'Found existing Pi at %s; keeping it.\n' "$PI_BIN"; fi
fi

SOURCE_DIR="${PI_CLOUD_SOURCE_DIR:-${PI_CLOUD_DATA_DIR:-$HOME/.pi-cloud}/source}"
if [ -d "$SOURCE_DIR/.git" ]; then
  git -C "$SOURCE_DIR" fetch --depth 1 origin main
  git -C "$SOURCE_DIR" reset --hard origin/main
else
  rm -rf "$SOURCE_DIR"
  mkdir -p "$(dirname "$SOURCE_DIR")"
  git clone --depth 1 "https://github.com/$REPO.git" "$SOURCE_DIR"
fi
(
  cd "$SOURCE_DIR"
  "$NPM_BIN" ci --ignore-scripts
  "$NPM_BIN" run build
)

configure_client_language() {
  local state_path="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/pi-cloud.json"
  PI_CLOUD_STATE_PATH="$state_path" PI_CLOUD_LOCALE="$LANGUAGE" "$NODE_BIN" <<'NODE'
const fs = require('node:fs');
const path = process.env.PI_CLOUD_STATE_PATH;
let state = { connections: [] };
try { state = JSON.parse(fs.readFileSync(path, 'utf8')); } catch {}
state.locale = process.env.PI_CLOUD_LOCALE;
state.connections ??= [];
fs.mkdirSync(require('node:path').dirname(path), { recursive: true, mode: 0o700 });
fs.writeFileSync(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
NODE
}

if [ "$ROLE" = "client" ] || [ "$ROLE" = "both" ]; then
  "$PI_BIN" install "$SOURCE_DIR"
  configure_client_language
  if [ "$LANGUAGE" = "zh-CN" ]; then
    printf '%s\n' '' '本地插件安装完成。' '1. 重启 Pi 或输入 /reload' '2. 输入 /cloud 打开首次使用向导'
  else
    printf '%s\n' '' 'Local extension installed.' '1. Restart Pi or enter /reload' '2. Enter /cloud to open the first-run guide'
  fi
fi

if [ "$ROLE" != "worker" ] && [ "$ROLE" != "both" ]; then exit 0; fi
if [ "$(uname -s)" != "Linux" ] || ! command -v systemctl >/dev/null 2>&1; then
  printf '%s\n' 'The Worker requires Linux with systemd.' >&2
  exit 1
fi

public_ip="$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
private_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [ -z "$IP" ]; then
  if [ "$LANGUAGE" = "zh-CN" ]; then
    ip_choice="$(ask "检测到公网 IP ${public_ip:-未知}，内网 IP ${private_ip:-未知}。请输入 Worker 对外 IP [${public_ip:-$private_ip}]：" "${public_ip:-$private_ip}")"
  else
    ip_choice="$(ask "Detected public IP ${public_ip:-unknown} and private IP ${private_ip:-unknown}. Worker public IP [${public_ip:-$private_ip}]: " "${public_ip:-$private_ip}")"
  fi
  IP="$ip_choice"
fi
if [ -z "$IP" ]; then printf '%s\n' 'A Worker IP is required.' >&2; exit 2; fi

if [ -z "$RUNNER" ]; then
  if command -v docker >/dev/null 2>&1; then
    if [ "$LANGUAGE" = "zh-CN" ]; then runner_choice="$(ask $'执行模式：\n  1) host（推荐先试用，使用服务账号权限）\n  2) Docker（隔离更强）\n> ' 1)"; else runner_choice="$(ask $'Execution mode:\n  1) host (recommended for the first trial)\n  2) Docker (stronger isolation)\n> ' 1)"; fi
    if [ "$runner_choice" = "2" ]; then RUNNER="docker"; else RUNNER="host"; fi
  else
    RUNNER="host"
  fi
fi
if [ "$RUNNER" != "host" ] && [ "$RUNNER" != "docker" ]; then printf '%s\n' 'Runner must be host or docker.' >&2; exit 2; fi

CLI="$SOURCE_DIR/dist/src/cli.js"
"$NODE_BIN" "$CLI" config set language "$LANGUAGE"
"$NODE_BIN" "$CLI" config set runner "$RUNNER"
if [ "$RUNNER" = "docker" ]; then
  docker build -f "$SOURCE_DIR/deploy/runner.Dockerfile" -t pi-cloud-worker:latest "$SOURCE_DIR"
fi
INSTALL_OUTPUT="$("$NODE_BIN" "$CLI" worker install --ip "$IP" --systemd)"
DATA_DIR="${PI_CLOUD_DATA_DIR:-$HOME/.pi-cloud}"
UNIT="$DATA_DIR/pi-cloud-worker.service"
$SUDO install -D -m 0644 "$UNIT" /etc/systemd/system/pi-cloud-worker.service
$SUDO systemctl daemon-reload
$SUDO systemctl enable --now pi-cloud-worker.service

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  open_firewall="$(ask "Open TCP port 9443 with UFW? [Y/n]: " y)"
  case "$open_firewall" in n|N|no|NO) ;; *) $SUDO ufw allow 9443/tcp ;; esac
fi

printf '%s\n' "$INSTALL_OUTPUT"
pair_command="$(printf '%s\n' "$INSTALL_OUTPUT" | sed -n 's/^pair-command=//p')"
printf '\n%s\n%s\n' '============================================================' "$pair_command"
if curl -kfsS --max-time 5 "https://127.0.0.1:9443/health" >/dev/null; then health="OK"; else health="FAILED"; fi
if [ "$LANGUAGE" = "zh-CN" ]; then
  printf '%s\n' '============================================================' "Worker 已启动，本机健康检查：${health}" '把上面的 /cloud-pair 整行复制到本地 Pi，然后输入 /cloud。'
else
  printf '%s\n' '============================================================' "Worker started; local health check: ${health}" 'Copy the complete /cloud-pair line above into local Pi, then enter /cloud.'
fi
