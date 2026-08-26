# Pi Cloud Computing

在自托管 Linux VPS 上继续运行本地 Pi 会话和 Git 工作区，并把代码与原生 session 结果安全带回本地。

Run a local Pi session and Git workspace on a self-hosted Linux VPS, then safely bring the code and native session results back.

[简体中文](#简体中文) | [English](#english)

---

## 简体中文

### 你需要什么

- 本地电脑：Windows、Linux 或 macOS。
- 云端服务器：带公网 IP 的 Linux VPS，推荐 Ubuntu 24.04。
- 项目必须是已有至少一个 commit 的 Git 仓库。
- 安装器会检查 Node.js 24、Git 和 Pi；已有 Pi 时不会重复安装。
- Worker 默认建议先使用 `host` 模式试用；需要更强隔离时可选择 Docker。

### 最简单的安装方式

安装器会依次询问：

1. 使用简体中文还是 English。
2. 安装本地 Pi 插件、Linux Worker，还是两者都安装。
3. Worker 对外 IP，自动显示检测到的公网 IP 和内网 IP。
4. Worker 使用 host 还是 Docker runner。
5. UFW 已启用时，是否放行 TCP 9443。

#### Windows 本地电脑

在 PowerShell 中运行：

```powershell
irm https://raw.githubusercontent.com/WSXYT/pi-cloud-computing/main/scripts/install.ps1 | iex
```

选择“简体中文”和“本地电脑：Pi 插件”。安装完成后重启 Pi，或在 Pi 中输入：

```text
/reload
/cloud
```

#### Linux 或 macOS 本地电脑

```bash
curl -fsSL https://raw.githubusercontent.com/WSXYT/pi-cloud-computing/main/scripts/install.sh | bash
```

选择“简体中文”和“本地电脑：Pi 插件”。

#### Linux VPS Worker

在 VPS 中运行同一条交互式安装命令：

```bash
curl -fsSL https://raw.githubusercontent.com/WSXYT/pi-cloud-computing/main/scripts/install.sh | bash
```

选择“简体中文”和“Linux VPS：云端 Worker”。也可以无交互安装：

```bash
curl -fsSL https://raw.githubusercontent.com/WSXYT/pi-cloud-computing/main/scripts/install.sh \
  | bash -s -- --worker --lang zh-CN --ip 149.88.93.8 --runner host --yes
```

安装结束会打印一整行命令，例如：

```text
/cloud-pair https://149.88.93.8:9443 SHA256指纹 一次性配对码
```

把这一整行复制到本地 Pi 即可。不要手工拆分或重新输入。

### 先装客户端，还是先装服务器？

两种顺序都可以：

- **先装服务器：** 安装结束保存 `/cloud-pair ...` 整行，之后在本地安装插件并粘贴。
- **先装客户端：** 在 `/cloud` 中选择“首次使用帮助”；服务器安装完成后粘贴它打印的 `/cloud-pair ...`。

### 本地 `/cloud` 使用流程

输入：

```text
/cloud
```

未配对时会显示：

- 配对 Worker
- 首次使用帮助
- 语言 / Language

配对后会显示：

- 提交当前会话
- 连接与任务状态
- 重连或中止活动任务
- 检查并应用返回结果
- 解除配对
- 帮助和语言

随时切换语言：

```text
/cloud-language
```

### 提交任务

在一个已有 commit 的 Git 仓库中启动 Pi，然后输入：

```text
/cloud-submit 只检查这个项目，并回复当前项目结构。不要修改文件。
```

提交前会出现多选清单：

- `Pi 运行环境`：extensions、skills、prompts、themes 和 Provider 摘要。
- `Git 工作区`：完整 Git bundle 加未提交和已选择的未跟踪文件；远程执行必需。
- `当前对话`：Pi 原生 JSONL session；可取消选择以启动新云端会话。
- `Pi Provider 凭据`：仅本地存在 `auth.json` 时显示，包含敏感内容，默认不选。

按键：

```text
↑↓ 移动    空格多选    Enter 确认    Esc 取消
```

明确选择“上传所选内容并启动”后才会上传。选择凭据时，数据通过已固定证书的 TLS 传输，在 Worker 端使用 AES-256-GCM 加密保存，执行时临时解密，结束后删除临时明文。

任务运行时，普通输入会发送到云端 Pi 的 `steer` 或 `followUp` 队列。管理命令：

```text
/cloud-status
/cloud-reconnect
/cloud-abort
```

### 获取结果

完成事件会包含 Git result 和原生 session artifact：

```text
/cloud-apply
/cloud-merge
```

`/cloud-apply` 会先重新计算本地 Git baseline。本地内容在提交后发生变化时，它会拒绝覆盖。

`/cloud-merge` 校验原生 entry ID 和 parentId，生成合并后的 JSONL session，再使用 Pi 的 `switchSession` API 切换。

### Worker 日常操作

以下命令均在 VPS 运行。稳定入口是编译后的 CLI：

```bash
CLI=/root/.pi-cloud/source/dist/src/cli.js
NODE=/usr/bin/node
```

查看状态：

```bash
$NODE $CLI worker status
systemctl status pi-cloud-worker --no-pager
curl -k https://127.0.0.1:9443/health
```

查看检测到的公网/内网 IP：

```bash
$NODE $CLI worker ips
```

服务运行时生成新的十分钟一次性配对码，无需重启：

```bash
$NODE $CLI worker pair
```

它会再次打印完整 `pair-command=/cloud-pair ...`。

查看和撤销客户端 token：

```bash
$NODE $CLI worker tokens
$NODE $CLI worker token revoke TOKEN_ID
```

清理过期任务：

```bash
$NODE $CLI config set retention-days 30
$NODE $CLI worker cleanup
```

查看日志：

```bash
journalctl -u pi-cloud-worker -n 200 --no-pager
journalctl -u pi-cloud-worker -f
```

### 更新

本地或 VPS 都可以重新运行同一条安装命令。安装器会更新 `~/.pi-cloud/source`、重新编译并保留现有连接、token、证书和配置。

```bash
curl -fsSL https://raw.githubusercontent.com/WSXYT/pi-cloud-computing/main/scripts/install.sh | bash
```

Windows 本地更新：

```powershell
irm https://raw.githubusercontent.com/WSXYT/pi-cloud-computing/main/scripts/install.ps1 | iex
```

### 常见问题

#### `CERTIFICATE_MISMATCH`

不要绕过。它表示本地保存的证书 pin 与当前 TLS 证书不一致。确认 VPS 没有被替换后，在本地执行 `/cloud-unpair`，在 VPS 执行 `worker pair`，再粘贴新的完整配对命令。证书本身变化时需要重新安装或明确轮换证书后再配对。

#### 连接不到 9443

```bash
systemctl is-active pi-cloud-worker
ss -ltnp | grep 9443
ufw allow 9443/tcp
curl -k https://127.0.0.1:9443/health
```

还需要在云服务商安全组中放行 TCP 9443。

#### `Git required` 或 `HEAD` 不存在

项目必须先创建至少一个 commit：

```bash
git init
git add .
git commit -m "initial"
```

#### 云端没有 Provider 凭据

重新提交，并在多选清单中主动勾选“Pi Provider 凭据”。它默认关闭，不会静默上传。

#### host 和 Docker 如何选择

- `host`：最容易试用，Pi 使用 systemd 服务账号权限运行。
- `docker`：无网络、只读根文件系统，只挂载任务工作区；安装器会构建专用 runner 镜像。

### 安全边界

- Pi 扩展和 Worker 都会执行代码，应只从你信任的仓库安装。
- TLS 使用带 IP SAN 的自签名证书，本地固定 SHA-256 指纹。
- 配对码十分钟有效且只能使用一次。
- token 可在 Worker 上单独撤销。
- 凭据不会默认上传。
- Git 结果不会直接覆盖本地工作区。
- 赞助商和中转推荐位目前仅为关闭状态的占位符，不接触任何任务数据。

---

## English

### Requirements

- Local computer: Windows, Linux, or macOS.
- Worker: a Linux VPS with a public IP; Ubuntu 24.04 is recommended.
- The project must be a Git repository with at least one commit.
- The installer checks Node.js 24, Git, and Pi. It keeps an existing Pi installation.
- Start with the `host` runner for the first trial; choose Docker for stronger isolation.

### One-command installation

The installer asks for language, client/Worker role, detected public/private IP, runner mode, and UFW access.

Windows client:

```powershell
irm https://raw.githubusercontent.com/WSXYT/pi-cloud-computing/main/scripts/install.ps1 | iex
```

Linux/macOS client or Linux Worker:

```bash
curl -fsSL https://raw.githubusercontent.com/WSXYT/pi-cloud-computing/main/scripts/install.sh | bash
```

Non-interactive Worker example:

```bash
curl -fsSL https://raw.githubusercontent.com/WSXYT/pi-cloud-computing/main/scripts/install.sh \
  | bash -s -- --worker --lang en --ip 149.88.93.8 --runner host --yes
```

At the end, the Worker prints one complete command:

```text
/cloud-pair https://149.88.93.8:9443 SHA256_FINGERPRINT ONE_TIME_CODE
```

Paste the complete line into local Pi. Either client-first or server-first installation works.

### Local workflow

Restart Pi or enter `/reload`, then open:

```text
/cloud
```

The first-run menu contains Pair Worker, Help, and Language. Once paired it becomes the status and task control center.

Switch language at any time:

```text
/cloud-language
```

From a Git repository with at least one commit:

```text
/cloud-submit Inspect this project and describe its structure. Do not change files.
```

The preflight is a real multi-select checklist. Use Up/Down, Space, Enter, and Escape. Git workspace is required; runtime environment and native session are optional. Pi provider credentials appear only when `auth.json` exists and are off by default.

While the task runs, normal input goes to remote Pi through `steer` or `followUp`. Commands:

```text
/cloud-status
/cloud-reconnect
/cloud-abort
/cloud-apply
/cloud-merge
```

Git results are baseline-checked before application. Native session results are validated by entry ID and parentId before Pi switches sessions.

### Worker operations

```bash
CLI=/root/.pi-cloud/source/dist/src/cli.js
NODE=/usr/bin/node

$NODE $CLI worker status
$NODE $CLI worker ips
$NODE $CLI worker pair
$NODE $CLI worker tokens
$NODE $CLI worker token revoke TOKEN_ID
journalctl -u pi-cloud-worker -f
```

`worker pair` works while the service is running and prints a complete copy-paste pairing command. Pairing codes expire after ten minutes and are single-use.

### Update

Run the same installer again. It updates and rebuilds the source while preserving existing state.

### Troubleshooting

- `CERTIFICATE_MISMATCH`: do not bypass it. Verify the VPS, unpair locally, generate a new pairing command, and pair again.
- Port unavailable: check `systemctl`, `ss -ltnp`, UFW, and the VPS provider security group.
- Missing Git `HEAD`: create an initial commit.
- Missing provider auth: submit again and explicitly select Pi provider credentials.
- `host` runs with the systemd service account permissions. Docker uses a no-network, read-only runner image with only the task workspace mounted.

### Development and release gates

```bash
npm ci
npm run check
npm test
npm run pack:smoke
npm audit --omit=dev
```

GitHub Actions runs the client suite on Ubuntu, Windows, and macOS, and builds both Worker Docker images on Linux.
