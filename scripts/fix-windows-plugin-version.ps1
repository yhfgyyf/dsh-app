param(
    [ValidateSet('check', 'apply', 'rollback')]
    [string]$Action = 'check',
    [string]$RuntimeRoot = 'D:\Programs\DSH Desktop\resources\runtime',
    [string]$UserData = (Join-Path $env:APPDATA 'DSH Desktop'),
    [string]$Backup = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Action = $Action.ToLowerInvariant()
if ($env:OS -ne 'Windows_NT') { throw 'Run this script on Windows.' }
if ($Action -eq 'rollback' -and [string]::IsNullOrWhiteSpace($Backup)) {
    throw 'Rollback requires the exact -Backup directory returned by apply.'
}
if ($Action -ne 'rollback' -and -not [string]::IsNullOrWhiteSpace($Backup)) {
    throw '-Backup is only used with rollback.'
}

$RuntimeRoot = (Resolve-Path -LiteralPath $RuntimeRoot).Path
$UserData = (Resolve-Path -LiteralPath $UserData).Path
$profileDir = Join-Path $UserData 'core\profiles\desktop'
$nodeBinary = Join-Path $RuntimeRoot 'bin\node.exe'
$installer = Join-Path $PSScriptRoot 'install-display-fix.mjs'
$source = Join-Path $PSScriptRoot 'plugin-bundle-metadata.mjs'
$backupRoot = Join-Path $UserData 'plugin-version-display-backups'

$required = @(
    $nodeBinary,
    $installer,
    $source,
    (Join-Path $profileDir 'package.json'),
    (Join-Path $profileDir 'cordis.patch.yml'),
    (Join-Path $RuntimeRoot 'node_modules\@deepseek-ai\dsh-plugin-manager\package.json'),
    (Join-Path $RuntimeRoot 'node_modules\@deepseek-ai\dsh-app-boot\package.json')
)
foreach ($path in $required) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required file missing: $path" }
}
$nodeVersion = & $nodeBinary --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) {
    throw 'The existing App runtime must provide Node 22 or newer.'
}
foreach ($package in @('dsh-plugin-manager', 'dsh-app-boot')) {
    $manifestPath = Join-Path $RuntimeRoot "node_modules\@deepseek-ai\$package\package.json"
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.version -ne '0.2.0-rc.1') {
        throw "This fix was verified with $package 0.2.0-rc.1; found $($manifest.version). No profile change was made."
    }
}

$payloadPaths = @('fix-windows-plugin-version.ps1', 'install-display-fix.mjs', 'plugin-bundle-metadata.mjs')
$payload = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'PAYLOAD-SHA256.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (@($payload.files).Count -ne $payloadPaths.Count) { throw 'Unexpected payload manifest; extract a fresh ZIP.' }
foreach ($relativePath in $payloadPaths) {
    $entries = @($payload.files | Where-Object { $_.path -eq $relativePath })
    if ($entries.Count -ne 1 -or $entries[0].sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw "Invalid checksum entry: $relativePath" }
    $actualHash = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $relativePath) -Algorithm SHA256).Hash
    if ($actualHash -ne $entries[0].sha256) { throw "Payload checksum mismatch: $relativePath" }
}

# Exclude shells, editors and Explorer even when their arguments mention DSH.
# Apply with the App closed so startup loads this exact module on Windows.
if ($Action -ne 'check') {
    $blockers = @(Get-CimInstance Win32_Process | Where-Object {
        if ($_.Name -match '^(DSH( Desktop)?|deepseek-harness)\.exe$') { return $true }
        if ($_.Name -notmatch '^(node|electron)\.exe$') { return $false }
        $executable = ([string]$_.ExecutablePath).Replace('/', '\')
        $arguments = ([string]$_.CommandLine).Replace('/', '\')
        return $executable.StartsWith($RuntimeRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
            $arguments.IndexOf($RuntimeRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $arguments.IndexOf($UserData, [StringComparison]::OrdinalIgnoreCase) -ge 0
    })
    if ($blockers.Count -gt 0) {
        $summary = ($blockers | ForEach-Object { "$($_.Name) PID=$($_.ProcessId)" }) -join ', '
        throw "Exit DSH Desktop before $Action. Still running: $summary"
    }
}

if ($Action -eq 'rollback') {
    $Backup = (Resolve-Path -LiteralPath $Backup).Path
    $record = Get-Content -LiteralPath (Join-Path $Backup 'change.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $expectedPatch = Join-Path $profileDir 'cordis.patch.yml'
    $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
    $expectedModule = Join-Path $profileDir ('local-plugins\desktop-plugin-bundle-metadata-' + $sourceHash.Substring(0, 12) + '.mjs')
    if ([IO.Path]::GetFullPath($record.patch) -ne $expectedPatch -or [IO.Path]::GetFullPath($record.module) -ne $expectedModule) {
        throw 'The backup belongs to a different profile or fix; no files were changed.'
    }
    & $nodeBinary $installer rollback $Backup
} else {
    & $nodeBinary $installer $Action $profileDir $RuntimeRoot $source $backupRoot
}
if ($LASTEXITCODE -ne 0) { throw 'Installer stopped. Preserve the profile and backups; inspect the error before retrying.' }
if ($Action -ne 'check') { Write-Host 'Done. Start DSH Desktop, open Plugins, click Refresh, then open the plugin details.' }
