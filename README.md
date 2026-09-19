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
4. Worker 使用 host 还是 Docker runner；Docker 是否允许访问模型 API 和安装依赖。
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

在本地 Pi 输入 `/cloud`，选择“已经安装好：粘贴配对命令”，粘贴这一整行即可。也保留直接执行 `/cloud-pair ...` 的快捷方式。

### 先装客户端，还是先装服务器？

两种顺序都可以：

- **先装服务器：** 安装结束保存 `/cloud-pair ...` 整行，之后在本地安装插件并粘贴。
- **先装客户端：** 在 `/cloud` 中选择“还没有 Worker：查看一键安装”，在 VPS 执行显示的命令，回来继续配对。

### 本地 `/cloud` 使用流程

输入：

```text
/cloud
```

只需记住这一个入口；TUI 根据当前状态引导下一步：

| 当前状态 | 主要操作 |
|---|---|
| 未配对 | 已安装则粘贴配对命令；未安装则查看 VPS 安装指引 |
| 已配对、项目首次使用 | 首次在云端运行此项目 |
| 任务运行中 | 返回对话查看输出、重连、中止（需确认） |
| 任务失败 | 重新提交，保留原记录并重新确认授权 |
| 结果返回 | 先审阅文件，再接回对话；各自确认，原会话保留 |

“更多设置与历史任务”提供服务器切换、凭据撤销、历史任务、帮助与语言。每个子页面可返回；不需要记忆底层命令。

### 提交任务

在已有 commit 的 Git 项目中启动 Pi，输入 `/cloud`，选择“首次在云端运行此项目”（后续为“提交当前会话”）。无需在服务器手动克隆项目。

1. **任务**：填写希望云端完成的工作。
2. **同步**：查看本地仓库路径、目标服务器、Git HEAD，以及下面的同步清单。云端使用独立任务副本，不覆盖本地目录。
3. **确认并启动**：检查同步范围、执行权限和凭据授权。拒绝确认会返回同步清单并保留选择；在清单退出则取消提交。

项目归档包含 Git 历史、已跟踪文件改动和未被忽略的新文件。未跟踪且被忽略的文件不上传；**已提交到 Git 的秘密仍在历史中，不会因取消凭据授权而被移除**。

同步清单：

- `Pi 运行环境`：插件及本地包、skills、prompts、themes 和已脱敏的 Provider 配置；不是只上传摘要。
- `Git 工作区`：完整 Git bundle 加未提交和已选择的未跟踪文件；远程执行必需。
- `当前对话`：Pi 原生 JSONL session；可取消选择以启动新云端会话。
- `Pi Provider 凭据`：检测到 `auth.json`、配置密钥或引用的环境变量时显示，包含敏感内容，默认不选。

按键：

```text
↑↓ 移动    空格多选    Enter 确认    Esc 取消
```

“下一步：检查并确认”本身不上传；只有最后确认后才会上传和启动。选择凭据时，数据通过已固定证书的 TLS 传输，在 Worker 端使用 AES-256-GCM 加密保存，执行时临时解密，结束后删除临时明文。

任务运行时，普通输入会发送到云端 Pi 的 `steer` 或 `followUp` 队列。管理命令：

```text
/cloud-status
/cloud-reconnect
/cloud-abort
```

### 上传中断或任务失败后

- 仍在运行但连接断开：使用 `/cloud-reconnect`，继续接收同一个任务，避免重复执行。
- 已失败：从 `/cloud` 选择“重新提交上次失败的任务”，或输入 `/cloud-retry`。重启 Pi 后也可通过 `pi -c` 回到原会话再重试。
- 重试保留失败记录，使用相同提示向**原 Worker 创建新任务**，重新检查当前项目、对话和同步范围。凭据仍须显式选择与确认；不会沿用上次授权。
- 环境、项目和对话归档分别按内容哈希复用；只有 Worker 确认已有相同内容时才跳过上传。内容已变化时重新上传。重试不是恢复原执行点，远端已执行的外部操作可能再次发生。

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
CLI="$HOME/.pi-cloud/source/dist/src/cli.js"
NODE="$(command -v node)"
```

查看状态：

```bash
$NODE $CLI worker status
systemctl status pi-cloud-worker --no-pager
$NODE $CLI worker health
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

本地或 VPS 都可以重新运行同一条安装命令。源码只做 fast-forward 更新；遇到本地修改、分叉提交或非 Git 目录会停止，不会抹掉数据。现有连接、任务、token、证书和配置会保留；损坏的状态文件会报错而不是被清空。Worker 必须通过固定证书的本机健康检查，才会报告安装就绪。

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
$NODE $CLI worker health
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
- `docker`：只读根文件系统，挂载本任务的工作区与临时运行环境。安装器会询问是否允许网络访问；模型 API 和依赖安装需要明确允许 `bridge`。无交互安装必须提供 `--docker-network bridge` 或 `none`，不会默认授权出网。

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

This is the only entry point you need to remember. Without a Worker it offers a server installation guide or pairing-command paste. After pairing, choose **Run this project in the cloud for the first time**. No manual server-side project clone is required.

The guided submission has three steps: **task → sync selection → final confirmation**. It shows the local repository, destination and Git HEAD. **Next: review and confirm** uploads nothing; declining final consent returns to your selections. Cancelling the selection exits without submitting.

The Worker creates a separate task copy. The project archive includes Git history, tracked changes and non-ignored new files; secrets already committed to Git are still included, even with credential authorization off.

During execution the home screen offers output, reconnect and abort. When results arrive it prioritizes file review, then conversation merge. **More settings and task history** contains server/credential management, history, language and help. Subcommands below remain optional shortcuts.

The preflight is a multi-select checklist. Use Up/Down, Space, Enter, and Escape. Git workspace is required; runtime environment and native session are selected by default but optional. The runtime archive contains plugins/packages, skills, prompts, themes and redacted provider configuration—not just metadata. Provider credentials appear when auth files, embedded keys or referenced environment variables are found, and are off by default.

While the task runs, normal input goes to remote Pi through `steer` or `followUp`. Commands:

```text
/cloud-status
/cloud-reconnect
/cloud-abort
/cloud-apply
/cloud-merge
```

Git results are baseline-checked before application. Native session results are validated by entry ID and parentId before Pi switches sessions.

### Interrupted uploads and retries

- If the task is still active but disconnected, use `/cloud-reconnect` to resume the same task without duplicating execution.
- For a failed task, choose **Retry the last failed task** in `/cloud`, or use `/cloud-retry`. After restarting Pi, use `pi -c` to return to its session first.
- Retry retains the failed record and creates a **new task on the original Worker**, using the same prompt and the current project/conversation. Review the sync choices again; credential authorization is never carried forward automatically.
- Environment, project and session archives are reused independently by content hash, only after the Worker confirms they exist. Changed content is uploaded again. This is not execution-point recovery: external actions already performed remotely may run again.

### Worker operations

```bash
CLI="$HOME/.pi-cloud/source/dist/src/cli.js"
NODE="$(command -v node)"

$NODE $CLI worker status
$NODE $CLI worker ips
$NODE $CLI worker pair
$NODE $CLI worker tokens
$NODE $CLI worker token revoke TOKEN_ID
journalctl -u pi-cloud-worker -f
```

`worker pair` works while the service is running and prints a complete copy-paste pairing command. Pairing codes expire after ten minutes and are single-use.

### Update

Run the same installer again. Source updates are fast-forward only: dirty checkouts, conflicting commits and non-Git directories are not overwritten. Language updates preserve paired connections and task recovery state; corrupt state stops installation instead of resetting it. The installer checks mandatory command exits, and the Worker must pass its pinned local health check before it reports readiness.

### Troubleshooting

- `CERTIFICATE_MISMATCH`: do not bypass it. Verify the VPS, unpair locally, generate a new pairing command, and pair again.
- Port unavailable: check `systemctl`, `ss -ltnp`, UFW, and the VPS provider security group.
- Missing Git `HEAD`: create an initial commit.
- Missing provider auth: submit again and explicitly select Pi provider credentials.
- `host` runs with the systemd service account permissions. Docker has a read-only root and mounts this task's workspace/runtime. The installer asks explicitly about egress; model APIs and dependency installation need `bridge`. Non-interactive Docker installs must pass `--docker-network bridge` or `none`.

### Development and release gates

```bash
npm ci
npm run check
npm test
npm run pack:smoke
npm audit --omit=dev
```

`pack:smoke` installs a real tarball in an isolated consumer, checks the CLI and deployment assets, and loads the extension through real Pi RPC. GitHub Actions verifies Ubuntu/Windows/macOS clients, real host and Docker tasks, Worker image startup, and non-root sudo/systemd installation and restart. Release procedure: [RELEASING.md](https://github.com/WSXYT/pi-cloud-computing/blob/main/RELEASING.md).
