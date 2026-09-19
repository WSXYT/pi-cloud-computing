param(
  [ValidateSet('zh-CN', 'en')][string]$Language,
  [ValidateSet('client', 'worker-guide')][string]$Role,
  [string]$Repo = $(if ($env:PI_CLOUD_REPO) { $env:PI_CLOUD_REPO } else { 'WSXYT/pi-cloud-computing' })
)

$ErrorActionPreference = 'Stop'

if (-not $Language) {
  Write-Host '选择语言 / Choose language:'
  Write-Host '  1) 简体中文'
  Write-Host '  2) English'
  $choice = Read-Host '>'
  $Language = if ($choice -eq '1') { 'zh-CN' } else { 'en' }
}
if (-not $Role) {
  if ($Language -eq 'zh-CN') {
    Write-Host '安装什么？'
    Write-Host '  1) 本地电脑：Pi 插件'
    Write-Host '  2) 显示 Linux VPS Worker 安装命令'
  } else {
    Write-Host 'What do you want to install?'
    Write-Host '  1) Local computer: Pi extension'
    Write-Host '  2) Show the Linux VPS Worker command'
  }
  $choice = Read-Host '>'
  $Role = if ($choice -eq '2') { 'worker-guide' } else { 'client' }
}
if ($Role -eq 'worker-guide') {
  Write-Host ''
  Write-Host 'Run this on the Linux VPS:'
  Write-Host "curl -fsSL https://raw.githubusercontent.com/$Repo/main/scripts/install.sh | bash"
  return
}

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

$node = Get-Command node -ErrorAction SilentlyContinue
$major = if ($node) { & $node.Source -p 'process.versions.node.split(".")[0]' } else { '' }
if ($major -ne '24') {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw 'Node.js 24 is required. Install Node.js 24 and run this installer again.'
  }
  winget install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw 'Node.js installation did not complete. Follow winget instructions and rerun the installer.' }
  Refresh-Path
  $node = Get-Command node -ErrorAction Stop
  $major = & $node.Source -p 'process.versions.node.split(".")[0]'
  if ($major -ne '24') { throw "Node.js 24 is required; found $(& $node.Source --version)." }
}
$npm = Join-Path (Split-Path $node.Source) 'npm.cmd'
Write-Host "Node $(& $node.Source --version) · npm $(& $npm --version)"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw 'Git is required.' }
  winget install --id Git.Git --exact --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw 'Git installation did not complete. Follow winget instructions and rerun the installer.' }
  Refresh-Path
}

$pi = Get-Command pi -ErrorAction SilentlyContinue
if (-not $pi) {
  & $npm install --global '@earendil-works/pi-coding-agent@0.85.1' --ignore-scripts
  if ($LASTEXITCODE -ne 0) { throw 'Pi installation failed.' }
  Refresh-Path
  $pi = Get-Command pi -ErrorAction Stop
  if ($Language -eq 'zh-CN') { Write-Host "已安装 Pi：$($pi.Source)" } else { Write-Host "Installed Pi: $($pi.Source)" }
} else {
  if ($Language -eq 'zh-CN') { Write-Host "检测到已有 Pi：$($pi.Source)，不重复安装。" } else { Write-Host "Found existing Pi at $($pi.Source); keeping it." }
}

$source = if ($env:PI_CLOUD_SOURCE_DIR) { $env:PI_CLOUD_SOURCE_DIR } else { Join-Path $HOME '.pi-cloud\source' }
if (Test-Path (Join-Path $source '.git')) {
  $dirty = git -C $source status --porcelain
  if ($LASTEXITCODE -ne 0) { throw "Could not inspect source directory: $source" }
  if ($dirty) { throw "Source directory has local changes: $source. Move it or set PI_CLOUD_SOURCE_DIR to a clean path; the installer will not discard your changes." }
  git -C $source fetch origin main
  if ($LASTEXITCODE -ne 0) { throw "git fetch failed" }
  git -C $source merge --ff-only FETCH_HEAD
  if ($LASTEXITCODE -ne 0) { throw 'Source update is not a fast-forward. Local commits were preserved; use a separate PI_CLOUD_SOURCE_DIR.' }
} else {
  if (Test-Path $source) { throw "Source directory exists but is not a Git checkout: $source. Move it or set PI_CLOUD_SOURCE_DIR to a clean path, then run the installer again." }
  New-Item -ItemType Directory -Force (Split-Path $source) | Out-Null
  git clone --depth 1 "https://github.com/$Repo.git" $source
  if ($LASTEXITCODE -ne 0) { throw "git clone failed" }
}
Push-Location $source
try {
  & $npm ci --ignore-scripts
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
  & $npm run build
  if ($LASTEXITCODE -ne 0) { throw 'npm build failed.' }
} finally {
  Pop-Location
}

& $pi.Source install $source
if ($LASTEXITCODE -ne 0) { throw 'Pi extension installation failed.' }
# Share the extension's locked, atomic update; preserve tokens/tasks and reject corrupt state.
& $node.Source (Join-Path $source 'dist\src\cli.js') client language $Language
if ($LASTEXITCODE -ne 0) { throw 'Client language could not be saved. Existing recovery state was preserved.' }

Write-Host ''
if ($Language -eq 'zh-CN') {
  Write-Host '本地插件安装完成。'
  Write-Host '1. 重启 Pi 或输入 /reload'
  Write-Host '2. 输入 /cloud 打开首次使用向导'
  Write-Host '3. 如果还没有服务器，/cloud 中的帮助会给出 VPS 安装命令'
} else {
  Write-Host 'Local extension installed.'
  Write-Host '1. Restart Pi or enter /reload'
  Write-Host '2. Enter /cloud to open the first-run guide'
  Write-Host '3. If no Worker exists yet, the /cloud help shows the VPS command'
}
