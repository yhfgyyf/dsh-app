# Prepare the official Node SDK before native addon lifecycle scripts run.
# This keeps node-gyp away from an unbounded download during npm ci.
$ErrorActionPreference = 'Stop'
$taskVersion = '24.15.0'
$taskSdk = Join-Path $env:RUNNER_TEMP "dsh-node-gyp-$taskVersion"
New-Item -ItemType Directory -Force -Path $taskSdk | Out-Null
$taskBase = "https://nodejs.org/dist/v$taskVersion"
$taskSums = (Invoke-WebRequest -Uri "$taskBase/SHASUMS256.txt" -TimeoutSec 120).Content
$taskFiles = @(
    @{ Remote = "node-v$taskVersion-headers.tar.gz"; Local = 'headers.tar.gz' },
    @{ Remote = 'win-x64/node.lib'; Local = 'node.lib' }
)
foreach ($taskFile in $taskFiles) {
    $taskPath = Join-Path $taskSdk $taskFile.Local
    Invoke-WebRequest -Uri "$taskBase/$($taskFile.Remote)" -OutFile $taskPath -TimeoutSec 120
    $taskPattern = '(?m)^([0-9a-f]{64})\s+\*?' + [regex]::Escape($taskFile.Remote) + '\r?$'
    $taskMatch = [regex]::Match($taskSums, $taskPattern)
    if (-not $taskMatch.Success -or (Get-FileHash $taskPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskMatch.Groups[1].Value) {
        throw "Official Node SDK checksum mismatch: $($taskFile.Remote)"
    }
}
& tar -xzf (Join-Path $taskSdk 'headers.tar.gz') -C $taskSdk
if ($LASTEXITCODE -ne 0) { throw 'Could not extract Node headers' }
$taskNodeRoot = Join-Path $taskSdk "node-v$taskVersion"
# node-gyp uses $(Configuration)/node.lib with an explicit --nodedir.
# Keep the usual architecture location for tools that consume the SDK directly.
foreach ($taskLibDir in @('x64', 'Release')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $taskNodeRoot $taskLibDir) | Out-Null
    Copy-Item (Join-Path $taskSdk 'node.lib') (Join-Path $taskNodeRoot "$taskLibDir/node.lib")
}
$taskPythonRoot = Get-ChildItem (Join-Path $env:AGENT_TOOLSDIRECTORY 'Python') -Directory -Filter '3.12.*' | Sort-Object Name -Descending | Select-Object -First 1
if (-not $taskPythonRoot) { throw 'The Windows build needs the installed Python 3.12 toolchain' }
$taskPython = Join-Path $taskPythonRoot.FullName 'x64/python.exe'
if (-not (Test-Path $taskPython)) { throw 'Python 3.12 executable is missing' }
"npm_config_nodedir=$taskNodeRoot" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
"NODE_GYP_FORCE_PYTHON=$taskPython" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
"npm_config_msvs_version=2022" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
Write-Output "Verified official Node $taskVersion headers and x64 import library; selected Python 3.12 and Visual Studio 2022."
