#!/usr/bin/env bash
set -euo pipefail

REPO="${PI_CLOUD_REPO:-WSXYT/pi-cloud-computing}"
ROLE=""
LANGUAGE=""
IP=""
RUNNER=""
DOCKER_NETWORK=""
ASSUME_YES=0
PAIR_URL=""
FINGERPRINT=""
PAIR_CODE=""
REVISION=""

while [ "$#" -gt 0 ]; do
  case "$1" in
  --client) ROLE="client" ;;
  --worker) ROLE="worker" ;;
  --both) printf '%s\n' 'Install one role per machine: use --client locally and --worker on the server.' >&2; exit 2 ;;
  --ip)
    shift
    IP="${1:-}"
    ;;
  --lang | --language)
    shift
    LANGUAGE="${1:-}"
    ;;
  --runner)
    shift
    RUNNER="${1:-}"
    ;;
  --docker-network)
    shift
    DOCKER_NETWORK="${1:-}"
    ;;
  --repo)
    shift
    REPO="${1:-}"
    ;;
  --pair-url) shift; PAIR_URL="${1:-}" ;;
  --fingerprint) shift; FINGERPRINT="${1:-}" ;;
  --code) shift; PAIR_CODE="${1:-}" ;;
  --revision) shift; REVISION="${1:-}" ;;
  -y | --yes) ASSUME_YES=1 ;;
  -h | --help)
    printf '%s\n' \
      'Pi Cloud installer' \
      '  --client                 Install/configure the local Pi extension' \
      '  --worker --ip ADDRESS    Install the native Worker service' \
      '  --lang zh-CN|en          Set interface language' \
      '  --runner host|docker     Set Worker isolation mode (host is the default)' \
      '  --docker-network none|bridge  Explicit Docker egress policy' \
      'Install one role per machine; run the client and Worker installers separately.'
    exit 0
    ;;
  *)
    printf 'Unknown option: %s\n' "$1" >&2
    exit 2
    ;;
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
  case "${LC_ALL:-${LANG:-}}" in zh* | ZH*) default_language="zh-CN" ;; esac
  if [ "$default_language" = "zh-CN" ]; then default_choice=1; else default_choice=2; fi
  language_choice="$(ask $'选择语言 / Choose language:\n  1) 简体中文\n  2) English\n> ' "$default_choice")"
  if [ "$language_choice" = "1" ] || [ "$language_choice" = "zh-CN" ]; then LANGUAGE="zh-CN"; else LANGUAGE="en"; fi
fi
if [ "$LANGUAGE" != "zh-CN" ] && [ "$LANGUAGE" != "en" ]; then
  printf '%s\n' 'Language must be zh-CN or en.' >&2
  exit 2
fi
if [ -n "$REVISION" ] && [[ ! "$REVISION" =~ ^[a-f0-9]{40}$ ]]; then
  printf '%s\n' 'Revision must be an exact Git commit.' >&2; exit 2
fi
if [ -n "$PAIR_URL$FINGERPRINT$PAIR_CODE" ] && { [ -z "$PAIR_URL" ] || [ -z "$FINGERPRINT" ] || [ -z "$PAIR_CODE" ]; }; then
  printf '%s\n' 'Pairing requires --pair-url, --fingerprint and --code together.' >&2; exit 2
fi

if [ -z "$ROLE" ]; then
  if [ "$LANGUAGE" = "zh-CN" ]; then
    role_choice="$(ask $'安装到哪里？\n  1) 本地电脑：Pi 插件\n  2) 服务器：原生云端 Worker\n> ' 1)"
  else
    role_choice="$(ask $'What do you want to install?\n  1) Local computer: Pi extension\n  2) Server: native cloud Worker\n> ' 1)"
  fi
  case "$role_choice" in 2) ROLE="worker" ;; *) ROLE="client" ;; esac
fi

if [ "$ROLE" = "worker" ] && [ "$(uname -s)" != "Linux" ] && [ "$(uname -s)" != "Darwin" ]; then
  printf '%s\n' 'Native Worker installation supports Linux and macOS from this shell. Use install.ps1 for Windows.' >&2
  exit 1
fi
if [ -n "$DOCKER_NETWORK" ] && [ "$DOCKER_NETWORK" != "none" ] && [ "$DOCKER_NETWORK" != "bridge" ]; then
  printf '%s\n' 'Docker network must be none or bridge.' >&2
  exit 2
fi
if [ "$RUNNER" = "docker" ] && [ "$ASSUME_YES" -eq 1 ] && [ -z "$DOCKER_NETWORK" ]; then
  printf '%s\n' 'Noninteractive Docker installation requires --docker-network bridge (model API access) or none (offline only).' >&2
  exit 2
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
if [ ! -x "$NPM_BIN" ]; then
  printf 'npm was not found beside %s.\n' "$NODE_BIN" >&2
  exit 1
fi
export PATH="$(dirname "$NODE_BIN"):$PATH"
printf 'Node %s · npm %s\n' "$($NODE_BIN --version)" "$($NPM_BIN --version)"

if ! command -v git >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then $SUDO apt-get install -y git; else
    printf '%s\n' 'Git is required.' >&2
    exit 1
  fi
fi

GLOBAL_PREFIX="$("$NPM_BIN" prefix --global)"
install_pi() {
  if [ -w "$GLOBAL_PREFIX" ] || [ -z "$SUDO" ]; then
    "$NPM_BIN" install --global --prefix "$GLOBAL_PREFIX" '@earendil-works/pi-coding-agent@0.85.1' --ignore-scripts
  else
    "$SUDO" env "PATH=$PATH" "$NPM_BIN" install --global --prefix "$GLOBAL_PREFIX" '@earendil-works/pi-coding-agent@0.85.1' --ignore-scripts
  fi
  hash -r
}
export PATH="$GLOBAL_PREFIX/bin:$PATH"
PI_BIN="$(command -v pi 2>/dev/null || true)"
if [ "$ROLE" = "worker" ]; then
  SYSTEM_PI="$GLOBAL_PREFIX/bin/pi"
  if [ ! -x "$SYSTEM_PI" ]; then install_pi; fi
  PI_BIN="$SYSTEM_PI"
  if [ "$LANGUAGE" = "zh-CN" ]; then printf 'Worker 使用系统 Pi：%s\n' "$PI_BIN"; else printf 'Worker will use system Pi: %s\n' "$PI_BIN"; fi
elif [ -z "$PI_BIN" ]; then
  install_pi
  PI_BIN="$(command -v pi)"
  if [ "$LANGUAGE" = "zh-CN" ]; then printf '已安装 Pi：%s\n' "$PI_BIN"; else printf 'Installed Pi: %s\n' "$PI_BIN"; fi
else
  if [ "$LANGUAGE" = "zh-CN" ]; then printf '检测到已有 Pi：%s，不重复安装。\n' "$PI_BIN"; else printf 'Found existing Pi at %s; keeping it.\n' "$PI_BIN"; fi
fi

SOURCE_DIR="${PI_CLOUD_SOURCE_DIR:-${PI_CLOUD_DATA_DIR:-$HOME/.pi-cloud}/source}"
if [ -d "$SOURCE_DIR/.git" ]; then
  source_status="$(git -C "$SOURCE_DIR" status --porcelain)"
  if [ -n "$source_status" ]; then
    printf '%s\n' "Source directory has local changes: $SOURCE_DIR" 'Move it or set PI_CLOUD_SOURCE_DIR to a clean path; the installer will not discard your changes.' >&2
    exit 1
  fi
  if [ -n "$REVISION" ]; then
    if [ "$(git -C "$SOURCE_DIR" rev-parse HEAD)" != "$REVISION" ]; then
      printf '%s\n' 'Existing source uses a different revision; keep it and choose a separate PI_CLOUD_SOURCE_DIR for this command.' >&2
      exit 1
    fi
  else
    git -C "$SOURCE_DIR" fetch origin main
    git -C "$SOURCE_DIR" merge --ff-only FETCH_HEAD
  fi
else
  if [ -e "$SOURCE_DIR" ]; then
    printf '%s\n' "Source directory exists but is not a Git checkout: $SOURCE_DIR" 'Move it or set PI_CLOUD_SOURCE_DIR to a clean path, then run the installer again.' >&2
    exit 1
  fi
  mkdir -p "$(dirname "$SOURCE_DIR")"
  git clone --depth 1 "https://github.com/$REPO.git" "$SOURCE_DIR"
  if [ -n "$REVISION" ]; then
    git -C "$SOURCE_DIR" fetch --depth 1 origin "$REVISION"
    git -C "$SOURCE_DIR" checkout --detach FETCH_HEAD
    [ "$(git -C "$SOURCE_DIR" rev-parse HEAD)" = "$REVISION" ] || { printf '%s\n' 'Source revision mismatch.' >&2; exit 1; }
  fi
fi
(
  cd "$SOURCE_DIR"
  "$NPM_BIN" ci --ignore-scripts
  "$NPM_BIN" run build
)

CLI="$SOURCE_DIR/dist/src/cli.js"
configure_client_language() {
  # Use the same BOM-tolerant, locked, atomic state update as the extension.
  "$NODE_BIN" "$CLI" client language "$LANGUAGE"
}

if [ "$ROLE" = "client" ]; then
  "$PI_BIN" install "$SOURCE_DIR"
  configure_client_language
  if [ -n "$PAIR_URL" ]; then
    "$NODE_BIN" "$CLI" client pair "$PAIR_URL" "$FINGERPRINT" "$PAIR_CODE"
  fi
  if [ "$LANGUAGE" = "zh-CN" ]; then
    printf '%s\n' '' '本地插件已配置。打开 Pi，输入任务后按 F6 云端执行；Enter 本地执行。已打开 Pi 时输入 /reload。'
  else
    printf '%s\n' '' 'Local extension configured. Open Pi: F6 sends the typed task to cloud; Enter stays local. Use /reload in an already open Pi.'
  fi
fi

if [ "$ROLE" != "worker" ]; then exit 0; fi
if [ "$(uname -s)" != "Linux" ] && [ "$(uname -s)" != "Darwin" ]; then
  printf '%s\n' 'Native Worker installation supports Linux and macOS. Use install.ps1 for Windows.' >&2
  exit 1
fi

public_ip="$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
private_ip=""
if [ "$(uname -s)" = "Linux" ]; then private_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"; fi
if [ "$(uname -s)" = "Darwin" ]; then private_ip="$(ipconfig getifaddr en0 2>/dev/null || true)"; fi
if [ -z "$IP" ]; then
  if [ "$LANGUAGE" = "zh-CN" ]; then
    ip_choice="$(ask "检测到公网 IP ${public_ip:-未知}，内网 IP ${private_ip:-未知}。请输入 Worker 对外 IP [${public_ip:-$private_ip}]：" "${public_ip:-$private_ip}")"
  else
    ip_choice="$(ask "Detected public IP ${public_ip:-unknown} and private IP ${private_ip:-unknown}. Worker public IP [${public_ip:-$private_ip}]: " "${public_ip:-$private_ip}")"
  fi
  IP="$ip_choice"
fi
if [ -z "$IP" ]; then
  printf '%s\n' 'A Worker IP is required.' >&2
  exit 2
fi

if [ -z "$RUNNER" ]; then RUNNER="host"; fi
if [ "$RUNNER" != "host" ] && [ "$RUNNER" != "docker" ]; then
  printf '%s\n' 'Runner must be host or docker.' >&2
  exit 2
fi

"$NODE_BIN" "$CLI" config set language "$LANGUAGE"
"$NODE_BIN" "$CLI" config set runner "$RUNNER"
if [ "$RUNNER" = "docker" ]; then
  if [ -z "$DOCKER_NETWORK" ]; then
    if [ "$LANGUAGE" = "zh-CN" ]; then
      network_choice="$(ask '允许 Docker 访问网络以调用模型 API 和安装依赖？[y/N]：' n)"
    else
      network_choice="$(ask 'Allow Docker network access for model APIs and dependencies? [y/N]: ' n)"
    fi
    case "$network_choice" in y | Y | yes | YES) DOCKER_NETWORK="bridge" ;; *) DOCKER_NETWORK="none" ;; esac
  fi
  "$NODE_BIN" "$CLI" config set docker-network "$DOCKER_NETWORK"
  if [ "$DOCKER_NETWORK" = "none" ]; then printf '%s\n' 'Docker is offline: cloud model API access is disabled until you explicitly enable bridge networking.'; fi
  if docker info >/dev/null 2>&1; then
    docker build -f "$SOURCE_DIR/deploy/runner.Dockerfile" -t pi-cloud-worker:latest "$SOURCE_DIR"
  else
    $SUDO docker build -f "$SOURCE_DIR/deploy/runner.Dockerfile" -t pi-cloud-worker:latest "$SOURCE_DIR"
  fi
fi
if [ "$(uname -s)" = "Linux" ]; then
  INSTALL_OUTPUT="$("$NODE_BIN" "$CLI" worker install --ip "$IP" --service)"
  DATA_DIR="${PI_CLOUD_DATA_DIR:-$HOME/.pi-cloud}"
  UNIT="$DATA_DIR/pi-cloud-worker.service"
  $SUDO install -D -m 0644 "$UNIT" /etc/systemd/system/pi-cloud-worker.service
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable pi-cloud-worker.service
  $SUDO systemctl restart pi-cloud-worker.service
else
  INSTALL_OUTPUT="$("$NODE_BIN" "$CLI" worker install --ip "$IP" --service)"
  "$NODE_BIN" "$CLI" worker start
fi

if [ "$(uname -s)" = "Linux" ] && command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  open_firewall="$(ask "Open TCP port 9443 with UFW? [Y/n]: " y)"
  case "$open_firewall" in n | N | no | NO) ;; *) $SUDO ufw allow 9443/tcp ;; esac
fi

health="FAILED"
for attempt in 1 2 3 4 5; do
  if "$NODE_BIN" "$CLI" worker health >/dev/null 2>&1; then health="OK"; break; fi
  if [ "$attempt" -lt 5 ]; then sleep 1; fi
done
if [ "$health" != "OK" ]; then
  printf '%s\n' 'Worker health check failed. Check the service: journalctl -u pi-cloud-worker (Linux) or launchctl print gui/$(id -u)/com.wsxyt.pi-cloud-worker (macOS). Installation is not ready for pairing.' >&2
  exit 1
fi
INSTALL_OUTPUT="$("$NODE_BIN" "$CLI" worker pair)"
printf '%s\n' "$INSTALL_OUTPUT"
pair_command="$(printf '%s\n' "$INSTALL_OUTPUT" | sed -n 's/^pair-command=//p')"
client_command_posix="$(printf '%s\n' "$INSTALL_OUTPUT" | sed -n 's/^client-command-posix=//p')"
client_command_powershell="$(printf '%s\n' "$INSTALL_OUTPUT" | sed -n 's/^client-command-powershell=//p')"
if [ -n "$client_command_posix" ] && [ -n "$client_command_powershell" ]; then
  printf '\n%s\n%s\n%s\n%s\n' '============================================================' "Local macOS/Linux terminal: $client_command_posix" "Local Windows PowerShell: $client_command_powershell" '============================================================'
else
  printf '%s\n' 'No verified one-click installer for this checkout. Install the client from a verified release, then enter this command inside Pi:' "$pair_command"
fi
if [ "$LANGUAGE" = "zh-CN" ]; then
  printf '%s\n' "Worker 已启动，本机健康检查：${health}" '请在本地电脑运行对应系统的一整行命令；配对码 10 分钟后过期，过期时在服务器运行 worker pair。'
else
  printf '%s\n' "Worker started; local health check: ${health}" 'Run the complete command for your local OS on your own computer. The pairing code expires in 10 minutes; run worker pair on the server to renew it.'
fi
