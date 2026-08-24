# pi-cloud-computing

`pi-cloud` is a CLI-only Pi package for running the current Pi session and Git workspace on a self-hosted Linux Worker, continuing the same remote conversation, and reviewing results locally.

## Requirements

- Local client: Windows, Linux, or macOS; Node.js 24; Git; Pi 0.84.x.
- Worker: Linux, Node.js 24, Git, OpenSSL, and a reachable VPS IP. Docker is optional; host execution is supported when the Worker is configured accordingly.
- The Worker uses a self-signed certificate with an IP SAN. Pairing pins its SHA-256 fingerprint; a changed certificate is rejected until the user explicitly pairs again.

## Install The Pi Package

```bash
npm install -g pi-cloud-computing
pi install npm:pi-cloud-computing
```

The package registers the Pi extension and the `pi-cloud` Worker CLI. Restart Pi after installing or use `/reload`.

## Start A Worker

On the Linux VPS:

```bash
pi-cloud worker install --ip 203.0.113.10 --systemd
sudo cp "$HOME/.pi-cloud/pi-cloud-worker.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pi-cloud-worker.service
```

The command prints the HTTPS address, certificate fingerprint, and one-time pairing code. Keep the pairing code private. For a container deployment, build from the repository with `docker build -f deploy/Dockerfile .`, mount `/var/lib/pi-cloud`, publish TCP 9443, and set the VPS IP in the Worker config before pairing.

Worker operations:

```bash
pi-cloud worker status
pi-cloud worker tls rotate --ip 203.0.113.10
pi-cloud worker cleanup
pi-cloud config set runner docker
pi-cloud config set retention-days 30
```

The default Docker runner has no network, a read-only root filesystem, and only the task workspace mounted. Host mode is a deliberate user choice and runs Pi with the Worker service account's permissions.

## Use From Pi

```text
/cloud-pair https://203.0.113.10:9443 SHA256_FINGERPRINT ONE_TIME_CODE
/cloud
```

`/cloud` opens the terminal selector. `/cloud-submit` displays the environment, Git, and session artifacts that will be uploaded and asks for confirmation. While a task is active, ordinary input is sent to the remote Pi using `steer` or `followUp`; `/cloud-abort` stops it. `/cloud-reconnect` resumes events by cursor after a disconnect. `/cloud-apply` reviews a returned Git snapshot and refuses to apply it if the local baseline changed. `/cloud-merge` imports a returned native JSONL session through Pi's session switch API.

Local state is stored under `~/.pi/agent/pi-cloud.json` with mode 0600. Provider secrets are not uploaded implicitly; authorized secret synchronization is a separate consent boundary.

The terminal UI and protocol use stable message keys with `zh-CN` and `en` catalogs. Unknown locales fall back to English. Sponsor and relay recommendations are inactive placeholders and never receive conversation, workspace, or secret data.

## Development

```bash
npm install
npm run check
npm test
npm run pack:smoke
npm audit --omit=dev
```

## 中文说明

`pi-cloud` 是仅 CLI 的 Pi 插件和自托管 Worker：它把当前 Pi 会话、Git 工作区和用户确认的运行时清单发送到 Linux VPS，在云端继续同一条 Pi 对话，再把结果以可检查的 Git snapshot 和原生 JSONL session 返回本地。

本地支持 Windows、Linux、macOS；Worker 首版支持 Linux、Node.js 24、Git、OpenSSL 和 VPS IP。Worker 使用带 IP SAN 的自签名证书，首次配对固定 SHA-256 指纹，证书变化必须重新配对。Docker runner 默认无网络、只读根文件系统，并只挂载任务工作区；host runner 需要用户明确配置。

服务器执行：`pi-cloud worker install --ip <VPS-IP> --systemd`，然后安装输出的 systemd unit。Pi 中使用 `/cloud-pair` 配对、`/cloud` 打开终端控制器、`/cloud-submit` 提交当前会话、`/cloud-reconnect` 断线重连、`/cloud-abort` 中止任务、`/cloud-apply` 检查并应用 Git 结果、`/cloud-merge` 合并原生 session。提交前会显示环境、Git 和 session 清单并等待确认；Provider secret 不会隐式上传。
