# Pi Cloud Computing

把本地 Pi 会话和 Git 工作区交给自托管 Worker 执行，再安全接回文件与原生对话。
Run your Pi session and Git workspace on a self-hosted Worker, then safely receive files and the native conversation.

[简体中文](#简体中文) · [English](#english) · [验收 / Acceptance](ACCEPTANCE.md) · [Release checklist](RELEASING.md)

## 简体中文

### 两台电脑，两个明确角色

- **本地电脑**安装 Pi 插件，负责输入、授权和接收结果。
- **服务器**安装 Worker，负责后台执行。Windows、macOS、Linux 都可原生运行，**不依赖 Docker**。
- 需要 Node.js **24.x**、Git、Pi（当前验证 **0.85.1**）。项目必须是至少有一个 commit 的 Git 仓库。
- 服务器需有本地电脑可访问的 IP，并允许 TCP **9443**；不一定要公网 IP，局域网/VPN 也可以。
- 原生 `host` 模式使用服务账号权限执行代码，不是安全沙箱。只连接自己信任的服务器；只同步信任的插件和依赖。

### 推荐：先装服务器，再复制本地连接命令

**Linux / macOS 服务器**（将 `SERVER_IP` 换成可访问的 IP）：

```bash
curl -fsSL https://raw.githubusercontent.com/WSXYT/pi-cloud-computing/main/scripts/install.sh \
  | bash -s -- --worker --lang zh-CN --ip SERVER_IP --yes
```

**Windows 服务器**：在管理员 PowerShell 下载并运行安装器。`SERVER_IP` 必须换成实际 IP。

```powershell
$p = Join-Path $env:TEMP ("pi-cloud-" + [guid]::NewGuid() + ".ps1")
try {
  Invoke-WebRequest https://raw.githubusercontent.com/WSXYT/pi-cloud-computing/main/scripts/install.ps1 -OutFile $p
  & $p -Role worker -Language zh-CN -Ip SERVER_IP
} finally { Remove-Item $p -ErrorAction SilentlyContinue }
```

安装器检查依赖、保留已有配置、注册后台服务，并通过固定证书的本机健康检查。**成功后才生成十分钟有效的一次性配对码**，同时打印：

- `client-command-posix=`：复制后面的命令到本地 macOS / Linux 终端。
- `client-command-powershell=`：复制后面的命令到本地 Windows PowerShell。

这两条命令自动安装/检测插件并配置连接；不需要逐项填写地址、指纹和配对码。命令固定到服务器的源码 commit。非干净官方 Git checkout 不会生成不可验证的安装链接，此时会提供 `/cloud-pair ...` 作为手动连接方式。

配对命令包含短期秘密，**不要贴进聊天、issue 或公开日志**。若过期，在服务器重新运行 `worker pair`。

已有 Pi 窗口执行 `/reload`；新开 Pi 直接开始。若先安装了本地插件，进入 `/cloud`，粘贴服务器生成的完整 `/cloud-pair ...` 即可。安装器只提供“本地插件”或“服务器”两个角色，不提供混合安装选项。

> `main` 链接安装主分支。开发/验收分支不等于已发布版本；生产更新前核对 [ACCEPTANCE.md](ACCEPTANCE.md) 和对应 commit 的 CI。

### 0.2.1 的服务端兼容要求

只更新本地插件**不会更新服务器**。本版在上传前检查 Worker 版本和任务存储健康状态；旧 Worker 必须先升级到 0.2.1 或更高版本。先检查原任务、保留数据，再安排服务升级/重启，用 `/cloud-status` 核对两端版本。原生 Worker 使用其安装包解析到的 Pi，避免误用 PATH 中的旧版本。升级不代表重跑原任务。

### 日常使用

在输入区写下任务：

| 操作 | 行为 |
|---|---|
| 空闲时 **Enter** | 正常交给本地 Pi |
| 空闲时 **F6** | 将当前输入作为云端任务，打开上传范围与授权确认 |
| 准备/上传时 **Esc / Ctrl+C / F6** | 取消实际请求，恢复原输入 |
| 云端运行时 | 输入区显示进度并默认锁定，不会把普通输入偷偷发给云端 |
| 运行时 **Esc / Ctrl+C** | 请求云端停止；停止未确认时再按 Esc 可只结束本地等待 |
| 运行时 **F6 → 追加指令** | 明确进入追加模式；Enter 只发送给当前云端任务 |
| 追加时 **Esc** | 返回进度，保留未发送的草稿 |
| 完成/失败后 | 释放输入区；普通 Enter 可继续本地，不必先处理结果 |

云端文字增量显示在原生进度区；完整回复、工具结果和错误进入可见对话记录，不自动触发本地模型。停止确认和尾部事件接收完成后释放输入区。

追加模式中的 `/cloud-abort ...`、其他 `/...` 或 `!...` **按文字发送**，不会被误当成本地管理命令。F6 菜单也提供返回本地、停止、重连。远程工具需要确认时会显示原生 Pi 对话框。

默认快捷键是 F6。若终端或其他扩展占用该键，先检查 `/hotkeys`，在 **`/cloud → 更多 → 云端快捷键`** 选择未使用的 F6–F12，或选择 `disabled` 禁用。保存后重新加载扩展，实际注册的按键同步显示在 `/hotkeys`。禁用时通过 `/cloud` 操作，普通文字仍被输入事件保护，不会自动发给模型。

### 一次清晰的上传授权

同步清单支持方向键移动、空格切换、Enter 进入确认、Esc 取消：

- **Git 工作区**：必需；Git 历史、已跟踪文件改动和选中的非忽略新文件。
- **Pi 运行环境**：插件、本地包、skills、prompts、themes 与已脱敏 Provider 配置。
- **当前对话**：可取消，改为新建云端会话。
- **Pi Provider 凭据**：检测到时显示，**默认不选**，必须明确授权。Worker 不继承宿主机或本机的登录、环境密钥；已加密缓存的凭据也必须按任务授权。不选时需另外明确确认“所选模型端点无需鉴权”，否则返回清单选择凭据或取消。普通付费/登录模型通常不能无凭据运行。

清单和“下一步”不会上传。最后确认才会传输；拒绝返回清单，退出保留草稿。每个任务使用独立副本，不要求手动在服务器克隆项目。

**Git 历史里已提交的秘密仍会随仓库上传**，取消凭据选项不会删除这些历史。授权凭据通过固定证书的 TLS 发送，在 Worker 加密存储，执行时临时解密，结束后清理明文；可通过 `/cloud` 撤销存储的凭据。

### 断线、取消与重试

- **上传取消**：Esc、Ctrl+C、`/cloud-cancel` 或上传中的 F6；中断网络请求，恢复草稿。
- **连接中断**：最多自动重连 5 次，单次等待不超过 10 秒，完整本地等待不超过 90 秒；随后释放输入。`/cloud-reconnect` 查询并恢复**原任务**。
- **停止未确认**：`/cloud-abort` 请求远端停止；30 秒无确认便释放本地输入，**不会谎报任务已停止**。稍后重连查询。
- **结果下载无进展**：30 秒结束等待，可再次获取。
- **任务失败**：`/cloud-retry` 在原 Worker 创建**新任务**，保留旧记录，重新确认同步范围和凭据。它不是恢复执行点，之前的外部操作可能重复。

传输失败会标明制品、阶段（连接/上传/等待响应/下载）、发送字节数、接收字节数和错误码；本机发送完不代表服务端确认。上传采用分块背压，仍以 30 秒无活动为网络等待上限，服务端另有 10 分钟总请求上限。`WORKER_STORAGE_ERROR` 会提示检查空间、inode 和权限，不再伪装成 `INVALID_FRAME`。

即使 Worker 回答“找不到原任务”，也**不会自动创建任务**；状态丢失和未收到提交无法仅凭这个回答区分，须明确确认重新执行，避免重复外部操作。

这些超时只结束本地等待，不决定服务器任务结果。历史任务、错误详情和恢复入口保留在 `/cloud`，不长期占用标题。

### 查看并接收结果

完成后自动校验并保存结果副本到本机，但不应用文件或切换对话；保存失败会明确提示重新获取，输入区仍释放。已保存的结果可离线接收。

`/cloud → 查看并接收云端结果`（或 `/cloud-receive`）先展示实际文件差异，再统一确认文件与对话，只确认一次：

1. 校验本地 Git baseline；提交后文件改变则拒绝覆盖。
2. 应用文件，保留可审阅的补丁和原始结果。
3. 校验会话 entry ID、父子关系与提交时的对话副本，创建并切换到新的原生 Pi 会话。

提交后继续在本地输入的对话会保留。原会话、提交时副本、结果文件及恢复材料不会被覆盖。文件成功而对话未完成时，重新接收仅重做未完成部分。也可以稍后处理结果，继续本地。

`/cloud-apply` 和 `/cloud-merge` 保留兼容，分别接收文件与对话。

### 服务管理与更新

源码安装后的 CLI 为 `~/.pi-cloud/source/dist/src/cli.js`；Windows 对应 `$HOME\.pi-cloud\source\dist\src\cli.js`：

```text
node <CLI路径> worker status
node <CLI路径> worker health
node <CLI路径> worker pair
node <CLI路径> worker start
node <CLI路径> worker stop
node <CLI路径> worker uninstall
node <CLI路径> worker tokens
node <CLI路径> worker token revoke TOKEN_ID
```

| 系统 | 原生后台托管 | 日志/注意事项 |
|---|---|---|
| Linux | systemd `pi-cloud-worker.service` | `journalctl -u pi-cloud-worker`；启停需要 sudo |
| macOS | 用户 launchd `com.wsxyt.pi-cloud-worker` | `~/.pi-cloud/worker.log`；用户登录时加载，不依赖原终端窗口 |
| Windows | Task Scheduler `PiCloudWorker`，S4U、最低权限 | `~/.pi-cloud/worker.log`；注册需要适当权限；无需保持交互登录；S4U 不提供网络共享/域凭据 |

`worker uninstall` 停止并注销后台服务，保留源码、任务、配置、证书和凭据；删除这些数据是另外的显式操作。Linux 卸载需要 sudo。

重跑相同角色安装器即可更新：只做 fast-forward，不重置有修改/分叉的 checkout，不清空现有连接、任务、证书或 token。固定 commit 安装遇到不同版本会要求独立源码目录，不会偷偷切换已有源码。损坏的状态会报错并保留原文件。

Windows 私有写入在 ACL 设置失败时拒绝保存。不要绕过 `CERTIFICATE_MISMATCH`：先核对服务器身份，再明确解除旧配对并重新连接。9443 不通时检查后台服务、系统防火墙及云服务商安全组。

Docker 是 Linux 上的可选隔离模式，不是三平台原生 Worker 的前提。显式使用 `--runner docker --docker-network bridge` 或 `none`；访问模型 API/安装依赖需要明确允许网络。

## English

### Install the server, then connect your local computer

There are two distinct roles: **local Pi extension** and **native Worker server**. Both support Windows, macOS and Linux. Native execution does **not require Docker**. Requirements: Node **24.x**, Git, Pi (verified with **0.85.1**), a repository with an initial commit, and a server IP reachable on TCP **9443** over your LAN, VPN or the Internet.

On Linux/macOS, run the server command above with `--lang en` and your actual IP. On Windows, run the PowerShell example with `-Language en` from an administrator terminal. Only run installers from a source you trust.

After dependency checks, service registration and a pinned local health check, the server prints **two ready-to-copy local commands**: POSIX and PowerShell. Run the appropriate command on your **local computer**. It detects/installs the extension and configures the connection automatically, pinned to the server's source commit. Pairing codes expire after ten minutes and are single-use. Do not publish the commands or codes.

Unverified/dirty source checkouts do not emit installer links; use a verified installation and the complete `/cloud-pair ...` line instead. A client-first installation can paste that line through `/cloud`. Existing Pi windows need `/reload`. Main-branch installer links are not a claim that a development candidate has been released.

### Input and authorization

- **Enter** stays local while idle. **F6** submits the editor draft to cloud preflight.
- Review the Git workspace, runtime resources, conversation and optional credentials. Credentials are **off by default**. Only the final consent uploads anything.
- During preparation/upload, **Esc, Ctrl+C or F6 cancels the request and restores the draft**.
- During execution, **Esc/Ctrl+C requests a real remote stop**. While it remains unconfirmed, a second Esc only ends local waiting. Streaming text appears in the native progress area; final replies/tool results/errors appear in the visible transcript without starting a local model turn.
- During execution the input area shows progress and is locked by default. **F6 → Append instruction** explicitly enables remote input; Enter sends it, Esc preserves the draft and returns to progress.
- Slash-prefixed and bang-prefixed instructions in append mode are sent **literally**, not interpreted as local commands. Remote authorization uses native Pi dialogs.
- Completion/failure releases the editor; you may continue locally before receiving results.
- Choose an unused F6–F12 through **`/cloud → More → Cloud shortcut`**. Check conflicts in `/hotkeys` first; saving reloads extensions and updates the actual registered shortcut. Choose `disabled` to use `/cloud` instead; ordinary text is still protected by the input hook.

The Worker never inherits server/client logins or environment keys. Cached credentials still require authorization for each task. Leaving credentials unchecked requires a separate explicit declaration that the selected model endpoint needs no authentication; otherwise return to the checklist or cancel. Ordinary paid/login-based models generally cannot run without credentials.

Uploads contain an independent task copy. Runtime synchronization includes plugins/packages, skills, prompts, themes and redacted provider configuration. Git history can still contain committed secrets even when credential sharing is disabled. Explicitly authorized credentials are TLS-pinned, encrypted at rest, temporarily materialized for execution and cleaned up afterward; revoke them through `/cloud`.

### Recovery and results

Automatic reconnect is limited to **five retries**, **10 seconds per attempt**, **under 90 seconds total local waiting**. `/cloud-reconnect` resumes the original task. `/cloud-abort` releases local waiting after **30 seconds without confirmation**, without claiming the remote task stopped. Result retrieval times out after **30 seconds without progress**. History and error details remain available without monopolizing the title.

Transfer failures identify the artifact, phase (connection/upload/response/download), local bytes sent/received and error code. Local send progress is not a remote acknowledgement. Uploads respect backpressure, retain a 30-second inactivity limit and have a separate 10-minute server request ceiling. Storage errors identify a safe cause such as `ENOSPC`, rather than being reported as invalid frames. A missing task on reconnect is **never automatically recreated**; lost state cannot prove that external effects never happened.

`/cloud-retry` creates a **new task on the original Worker**, preserves the failed record and requests fresh consent; external effects may repeat. `/cloud-cancel` cancels preparation/upload rather than merely hiding its UI.

Completed results are automatically validated and cached locally, without applying files or switching sessions; validated cached results remain usable offline. A cache failure offers refetch, not task re-execution. Choose **View and receive remote results** in `/cloud`, or run `/cloud-receive`. The actual file diff is shown before one confirmation applies baseline-checked files and merges the native session. Local conversation added since submission is retained. Originals, review patches, submitted-session copies and result artifacts remain available. Repeating after partial success handles only unfinished phases. Local file changes prevent overwrite. `/cloud-apply` and `/cloud-merge` remain compatibility commands; receipt can be deferred while you work locally.

### Operations and security

**Updating the local plugin does not update the server.** This client requires Worker 0.2.1+ diagnostics and checks storage health before uploads. Inspect original tasks, preserve data, then schedule the server upgrade/restart. `/cloud-status` shows both versions. Native Workers resolve Pi from their own installation, not an older global Pi on PATH. Upgrading is not permission to rerun tasks.

Use `node <CLI> worker status|health|pair|start|stop|uninstall`, where `<CLI>` is `~/.pi-cloud/source/dist/src/cli.js`. Linux uses systemd (sudo for service management), macOS uses a user launchd agent loaded at login, and Windows uses a least-privilege S4U scheduled task without an interactive-login requirement. Closing the installer terminal does not stop the Worker. `worker uninstall` stops/unregisters the service while retaining source, task data, configuration, certificates and credentials; Linux requires sudo. macOS/Windows logs are in the Worker data directory's `worker.log`; Linux uses `journalctl -u pi-cloud-worker`.

Native host tasks run with the service account's permissions, **not inside a security sandbox**. Windows S4U does not grant network-share/domain credentials. Linux Docker is an explicit optional isolation mode with explicit egress consent. Windows private writes fail closed on ACL setup failure. Never bypass certificate mismatches. Updates preserve state, refuse destructive checkout resets, and fail on corrupt recovery data rather than silently resetting it.

### Development and acceptance

```bash
npm ci
npm run check
npm test
npm run pack:smoke
npm audit --omit=dev
```

CI runs native clients and installed services on all three systems, real Pi task/tool/dialog/result flows, real PTY/ConPTY interaction, cross-platform artifact compatibility, package installation/loading, and Linux Docker execution. The PTY dependency is **development-only**. See [ACCEPTANCE.md](ACCEPTANCE.md) for evidence and scope, and [RELEASING.md](RELEASING.md) for exact-commit release gates. Skips and mocks are not platform acceptance. Sponsor/referral placeholders remain disabled and receive no task data.
