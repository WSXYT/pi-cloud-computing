$ErrorActionPreference = 'Stop'
$repo = if ($env:PI_CLOUD_REPO) { $env:PI_CLOUD_REPO } else { 'WSXYT/pi-cloud-computing' }
$package = "github:$repo"

$node = Get-Command node -ErrorAction SilentlyContinue
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $node -or -not $npm) {
  throw 'Node.js 24 and npm are required. Install Node.js 24, then run this script again.'
}
$major = node -p 'process.versions.node.split(".")[0]'
if ($major -ne '24') { throw "Node.js 24 is required; found $(node --version)." }

if (-not (Get-Command pi -ErrorAction SilentlyContinue)) {
  npm install --global '@earendil-works/pi-coding-agent@0.84.2'
}
npm install --global $package
pi install $package

Write-Host ''
Write-Host 'Pi Cloud client installed. Restart Pi or run /reload.'
Write-Host 'Next: /cloud-pair <https-url> <fingerprint> <pairing-code>'
Write-Host 'The Worker must run on Linux; use scripts/install.sh --worker --ip <VPS-IP> there.'
