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
  Refresh-Path
}

$pi = Get-Command pi -ErrorAction SilentlyContinue
if (-not $pi) {
  & $npm install --global '@earendil-works/pi-coding-agent@0.84.2' --ignore-scripts
  Refresh-Path
  $pi = Get-Command pi -ErrorAction Stop
  if ($Language -eq 'zh-CN') { Write-Host "已安装 Pi：$($pi.Source)" } else { Write-Host "Installed Pi: $($pi.Source)" }
} else {
  if ($Language -eq 'zh-CN') { Write-Host "检测到已有 Pi：$($pi.Source)，不重复安装。" } else { Write-Host "Found existing Pi at $($pi.Source); keeping it." }
}

$source = if ($env:PI_CLOUD_SOURCE_DIR) { $env:PI_CLOUD_SOURCE_DIR } else { Join-Path $HOME '.pi-cloud\source' }
if (Test-Path (Join-Path $source '.git')) {
  git -C $source fetch --depth 1 origin main
  git -C $source reset --hard origin/main
} else {
  if (Test-Path $source) { Remove-Item -Recurse -Force $source }
  New-Item -ItemType Directory -Force (Split-Path $source) | Out-Null
  git clone --depth 1 "https://github.com/$Repo.git" $source
}
Push-Location $source
try {
  & $npm ci --ignore-scripts
  & $npm run build
} finally {
  Pop-Location
}

& $pi.Source install $source
$agentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $HOME '.pi\agent' }
$statePath = Join-Path $agentDir 'pi-cloud.json'
$state = if (Test-Path $statePath) { Get-Content -Raw $statePath | ConvertFrom-Json } else { [pscustomobject]@{ connections = @() } }
if (-not $state.PSObject.Properties['connections']) { $state | Add-Member -NotePropertyName connections -NotePropertyValue @() }
if ($state.PSObject.Properties['locale']) { $state.locale = $Language } else { $state | Add-Member -NotePropertyName locale -NotePropertyValue $Language }
New-Item -ItemType Directory -Force $agentDir | Out-Null
$state | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8 $statePath

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
