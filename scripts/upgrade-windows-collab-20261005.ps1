param(
    [ValidateSet('check', 'apply', 'rollback')]
    [string]$Action = 'check',
    [string]$Backup = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# These paths were reported by the running Windows installation on 2026-10-05.
$runtimeRoot = 'D:\Programs\DSH Desktop\resources\runtime'
$dataDir = 'C:\Users\yhfgy\AppData\Roaming\DSH Desktop'
$stateHome = Join-Path $dataDir 'core'
$profileDir = Join-Path $stateHome 'profiles\desktop'
$backups = Join-Path $dataDir 'collab-plugin-backups'
$node = Join-Path $runtimeRoot 'bin\node.exe'
$installer = Join-Path $PSScriptRoot 'install-collab-plugin.mjs'

if ($Action -eq 'rollback' -and [string]::IsNullOrWhiteSpace($Backup)) {
    throw 'Rollback requires the exact -Backup path returned by apply.'
}
if ($Action -ne 'rollback' -and -not [string]::IsNullOrWhiteSpace($Backup)) {
    throw '-Backup is only used for rollback.'
}

$required = @(
    $node,
    (Join-Path $runtimeRoot 'package-manager\node_modules\pnpm\bin\pnpm.mjs'),
    (Join-Path $profileDir 'package.json'),
    (Join-Path $profileDir 'node_modules\dsh-p2p-collab\package.json'),
    (Join-Path $stateHome 'collaboration\profile.json'),
    (Join-Path $dataDir 'remote-access.json')
)
foreach ($path in $required) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Expected existing installation file was not found: $path"
    }
}
Get-Command tar.exe -ErrorAction Stop | Out-Null
$nodeVersion = & $node --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) {
    throw 'The existing runtime must provide Node 22 or newer.'
}

$payloadPaths = @('install-collab-plugin.mjs', 'package/package.json', 'package/index.js', 'package/client.js', 'package/cordis.patch.yml', 'dsh-p2p-collab-0.2.0.tgz')
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'PAYLOAD-SHA256.json') -Raw | ConvertFrom-Json
if (@($manifest.files).Count -ne $payloadPaths.Count) {
    throw 'Unexpected payload manifest. Extract a fresh copy of this upgrade ZIP.'
}
foreach ($relativePath in $payloadPaths) {
    $entries = @($manifest.files | Where-Object { $_.path -eq $relativePath })
    if ($entries.Count -ne 1 -or $entries[0].sha256 -notmatch '^[a-fA-F0-9]{64}$') {
        throw "Invalid payload checksum entry: $relativePath"
    }
    $actualHash = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $relativePath) -Algorithm SHA256).Hash
    if ($actualHash -ne $entries[0].sha256) {
        throw "Payload checksum mismatch: $relativePath"
    }
}

$installed = Get-Content -LiteralPath (Join-Path $profileDir 'node_modules\dsh-p2p-collab\package.json') -Raw | ConvertFrom-Json
if ($Action -eq 'apply' -and $installed.version -ne '0.1.4') {
    throw "Expected the reported plugin 0.1.4; found $($installed.version). Inspect before another upgrade."
}
# Backups inherit the existing user-data directory permissions and are permanent
# local package sources. Never delete them while their packages remain installed.
if (-not (Test-Path -LiteralPath $backups)) {
    New-Item -ItemType Directory -Path $backups | Out-Null
}

$pluginArgs = @(
    '--package', (Join-Path $PSScriptRoot 'package'),
    '--runtime', $runtimeRoot,
    '--profile', $profileDir,
    '--state-home', $stateHome,
    '--credentials-home', $dataDir,
    '--backups', $backups
)
if ($Action -ne 'check') { $pluginArgs += '--offline' }
if ($Action -eq 'rollback') { $pluginArgs += @('--backup', $Backup) }

# The installer verifies paused work and stopped DSH processes before any switch.
& $node $installer $Action @pluginArgs
if ($LASTEXITCODE -ne 0) {
    throw "Installer stopped. Keep the existing profile and backups at $backups; do not reset registration."
}
