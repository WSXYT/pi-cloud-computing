#!/usr/bin/env bash
set -euo pipefail
# This intentionally exercises sudo/systemd/global npm ONLY on an ephemeral GitHub Linux runner.
if [ "${GITHUB_ACTIONS:-}" != "true" ] || [ "$(uname -s)" != "Linux" ]; then
  printf '%s\n' 'Run only in the ephemeral Linux CI job.' >&2
  exit 1
fi
root="$(mktemp -d "$RUNNER_TEMP/pi-cloud-install-XXXXXX")"
cleanup() {
  sudo systemctl stop pi-cloud-worker.service || true
  sudo rm -f /etc/systemd/system/pi-cloud-worker.service
  sudo systemctl daemon-reload
}
trap cleanup EXIT
# A local remote containing exactly the candidate SHA exercises the normal fetch/fast-forward path.
git init --bare "$root/origin.git"
git -C "$GITHUB_WORKSPACE" push "$root/origin.git" HEAD:refs/heads/main
git clone --branch main "$root/origin.git" "$root/source"
export PI_CLOUD_SOURCE_DIR="$root/source"
export PI_CLOUD_DATA_DIR="$root/worker"
export npm_config_prefix="/opt/pi-cloud-ci-global"
sudo mkdir -p "$npm_config_prefix"
sudo chown root:root "$npm_config_prefix"
sudo chmod 755 "$npm_config_prefix"
for runner in host docker; do
  bash "$PI_CLOUD_SOURCE_DIR/scripts/install.sh" --worker --ip 127.0.0.1 --lang en --runner "$runner" --docker-network bridge --yes > "$root/install-$runner.log" 2>&1 || {
    cat "$root/install-$runner.log"
    sudo journalctl -u pi-cloud-worker -n 80 --no-pager
    exit 1
  }
  systemctl is-active --quiet pi-cloud-worker.service
  node "$PI_CLOUD_SOURCE_DIR/dist/src/cli.js" worker health
  sudo systemctl restart pi-cloud-worker.service
  for attempt in 1 2 3 4 5; do
    if node "$PI_CLOUD_SOURCE_DIR/dist/src/cli.js" worker health; then break; fi
    if [ "$attempt" -eq 5 ]; then exit 1; fi
    sleep 1
  done
  sudo systemctl stop pi-cloud-worker.service
  if systemctl is-active --quiet pi-cloud-worker.service; then exit 1; fi
  printf 'Verified non-root sudo installation, readiness, restart and stop: %s\n' "$runner"
done
