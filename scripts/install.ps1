param(
  [ValidateSet('zh-CN', 'en')][string]$Language,
  [ValidateSet('client', 'worker')][string]$Role,
  [string]$Ip,
  [string]$PairUrl,
  [string]$Fingerprint,
  [string]$Code,
  [string]$Revision,
  [string]$Repo = $(if ($env:PI_CLOUD_REPO) { $env:PI_CLOUD_REPO } else { 'WSXYT/pi-cloud-computing' })
)

$ErrorActionPreference = 'Stop'
if ($Revision -and $Revision -notmatch '^[a-f0-9]{40}$') { throw 'Revision must be an exact Git commit.' }
if (($PairUrl -or $Fingerprint -or $Code) -and -not ($PairUrl -and $Fingerprint -and $Code)) { throw 'Pairing requires PairUrl, Fingerprint and Code together.' }

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
    Write-Host '  2) 本机：原生云端 Worker'
  } else {
    Write-Host 'What do you want to install?'
    Write-Host '  1) Local computer: Pi extension'
    Write-Host '  2) This computer: native cloud Worker'
  }
  $choice = Read-Host '>'
  $Role = if ($choice -eq '2') { 'worker' } else { 'client' }
}
if ($Role -eq 'worker' -and -not $Ip) {
  $Ip = Read-Host 'Worker public or reachable IP address'
}
if ($Role -eq 'worker' -and -not $Ip) { throw 'A Worker IP is required.' }

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

$node = Get-Command node -ErrorAction SilentlyContinue
$major = if ($node) { & $node.Source -p 'parseInt(process.versions.node)' } else { '' }
if ($major -ne '24') {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw 'Node.js 24 is required. Install Node.js 24 and run this installer again.'
  }
  winget install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw 'Node.js installation did not complete. Follow winget instructions and rerun the installer.' }
  Refresh-Path
  $node = Get-Command node -ErrorAction Stop
  $major = & $node.Source -p 'parseInt(process.versions.node)'
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
  if ($Revision) {
    $existingRevision = git -C $source rev-parse HEAD
    if ($LASTEXITCODE -ne 0 -or $existingRevision -ne $Revision) { throw 'Existing source uses a different revision. Choose a separate PI_CLOUD_SOURCE_DIR; nothing was reset.' }
  } else {
    git -C $source fetch origin main
    if ($LASTEXITCODE -ne 0) { throw "git fetch failed" }
    git -C $source merge --ff-only FETCH_HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Source update is not a fast-forward. Local commits were preserved; use a separate PI_CLOUD_SOURCE_DIR.' }
  }
} else {
  if (Test-Path $source) { throw "Source directory exists but is not a Git checkout: $source. Move it or set PI_CLOUD_SOURCE_DIR to a clean path, then run the installer again." }
  New-Item -ItemType Directory -Force (Split-Path $source) | Out-Null
  git clone --depth 1 "https://github.com/$Repo.git" $source
  if ($LASTEXITCODE -ne 0) { throw "git clone failed" }
  if ($Revision) {
    git -C $source fetch --depth 1 origin $Revision
    if ($LASTEXITCODE -ne 0) { throw 'Could not fetch the pinned source revision.' }
    git -C $source checkout --detach FETCH_HEAD
    if ($LASTEXITCODE -ne 0 -or (git -C $source rev-parse HEAD) -ne $Revision) { throw 'Source revision mismatch.' }
  }
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

$cli = Join-Path $source 'dist\src\cli.js'
if ($Role -eq 'client') {
  & $pi.Source install $source
  if ($LASTEXITCODE -ne 0) { throw 'Pi extension installation failed.' }
  # Share the extension's locked, atomic update; preserve tokens/tasks and reject corrupt state.
  & $node.Source $cli client language $Language
  if ($LASTEXITCODE -ne 0) { throw 'Client language could not be saved. Existing recovery state was preserved.' }
  if ($PairUrl) {
    & $node.Source $cli client pair $PairUrl $Fingerprint $Code
    if ($LASTEXITCODE -ne 0) { throw 'Pairing failed. Existing state was preserved; generate a fresh pairing command on the Worker if the code expired.' }
  }

  Write-Host ''
  if ($Language -eq 'zh-CN') {
    Write-Host '本地插件已配置。打开 Pi，输入任务后按 F6 云端执行；Enter 本地执行。已打开 Pi 时输入 /reload。'
  } else {
    Write-Host 'Local extension configured. Open Pi: F6 sends the typed task to cloud; Enter stays local. Use /reload in an already open Pi.'
  }
  return
}

& $node.Source $cli config set language $Language
if ($LASTEXITCODE -ne 0) { throw 'Worker language could not be saved.' }
& $node.Source $cli config set runner host
if ($LASTEXITCODE -ne 0) { throw 'Worker host runner could not be configured.' }
$installOutput = & $node.Source $cli worker install --ip $Ip --service
if ($LASTEXITCODE -ne 0) { throw 'Worker service installation failed.' }
& $node.Source $cli worker start
if ($LASTEXITCODE -ne 0) { throw 'Worker service could not be started.' }
& $node.Source $cli worker health
if ($LASTEXITCODE -ne 0) { throw 'Worker health check failed.' }
$installOutput = & $node.Source $cli worker pair
if ($LASTEXITCODE -ne 0) { throw 'Worker started, but could not generate a pairing code.' }
$installOutput | ForEach-Object { Write-Host $_ }
$pairCommand = $installOutput | Where-Object { $_ -like 'pair-command=*' } | Select-Object -First 1
$clientPosix = $installOutput | Where-Object { $_ -like 'client-command-posix=*' } | Select-Object -First 1
$clientPowershell = $installOutput | Where-Object { $_ -like 'client-command-powershell=*' } | Select-Object -First 1
Write-Host ''
Write-Host 'Worker started and passed its local health check.'
if ($clientPosix -and $clientPowershell) {
  Write-Host 'Run one of these on your LOCAL computer within 10 minutes:'
  Write-Host "macOS/Linux: $($clientPosix -replace '^client-command-posix=', '')"
  Write-Host "Windows PowerShell: $($clientPowershell -replace '^client-command-powershell=', '')"
} elseif ($pairCommand) {
  Write-Host 'Installer link unavailable for this checkout; install the client from a verified release and then run this inside Pi:'
  Write-Host ($pairCommand -replace '^pair-command=', '')
}
