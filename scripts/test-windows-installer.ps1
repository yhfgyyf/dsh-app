$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$artifact = Get-Content (Join-Path $root 'release/latest-windows.json') -Raw | ConvertFrom-Json
$data = Join-Path $root ('.test-data/installer-' + [guid]::NewGuid().ToString())
$install = Join-Path $data 'Install With Spaces'
$config = Join-Path $data 'user-home'
New-Item -ItemType Directory -Path $config -Force | Out-Null
$sentinel = Join-Path $config 'keep-on-uninstall.txt'
Set-Content -Path $sentinel -Value 'DSH user data must survive uninstall'
$installLog = Join-Path $data 'install.log'
$setup = Start-Process -FilePath $artifact.installer -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', ('/DIR="' + $install + '"'), ('/LOG="' + $installLog + '"')) -Wait -PassThru
if ($setup.ExitCode -ne 0) {
  if (Test-Path $installLog) {
    Select-String -Path $installLog -Pattern 'Exception|Error[ :]|aborted|failed:' -Context 2,4 | Select-Object -Last 8 | Out-String | Write-Output
    Get-Content $installLog -Tail 20 | Write-Output
  }
  throw "Installer failed: $($setup.ExitCode)"
}
$exe = Join-Path $install 'DSH Desktop.exe'
$node = Join-Path $install 'resources/runtime/bin/node.exe'
if (!(Test-Path $exe) -or !(Test-Path $node)) { throw 'Installed binaries are missing' }
& node (Join-Path $root 'scripts/verify-windows-runtime.ts') $install $artifact.app
if ($LASTEXITCODE -ne 0) { throw 'Installed runtime verification failed' }
$env:DSH_HOME = $config
$env:DSH_DESKTOP_CONFIG_HOME = $config
$env:DSH_DESKTOP_DATA_DIR = Join-Path $data 'desktop-state'
$env:DSH_TELEMETRY_DISABLED = '1'
& node (Join-Path $root 'scripts/test-windows-update.ts') $install $artifact.installer (Join-Path $data 'updates')
if ($LASTEXITCODE -ne 0) { throw 'Installed application update failed' }
& node (Join-Path $root 'scripts/verify-windows-runtime.ts') $install $artifact.app
if ($LASTEXITCODE -ne 0) { throw 'Updated runtime verification failed' }

$updateReport = Get-Content (Join-Path $data 'updates/report.json') -Raw | ConvertFrom-Json
$application = Get-Process -Id $updateReport.newPid
$corePid = $null
try {
  $deadline = (Get-Date).AddSeconds(60)
  do {
    Start-Sleep -Milliseconds 500
    $application.Refresh()
    if ($application.HasExited) { throw 'Installed application exited during startup' }
    $core = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($application.Id)" | Where-Object { $_.ExecutablePath -eq $node } | Select-Object -First 1
    if ($core) { $corePid = $core.ProcessId }
    $transport = Join-Path $env:DSH_DESKTOP_DATA_DIR 'core/desktop-transport.json'
    $ready = $corePid -and $application.MainWindowHandle -ne 0 -and (Test-Path $transport)
  } until ($ready -or (Get-Date) -gt $deadline)
  if (!$ready) { throw 'Installed application did not create its window and owned core' }
  if (!$application.CloseMainWindow()) { throw 'Application window could not receive close request' }
  # Window close deliberately preserves the Host for phone connections.
  if ($application.WaitForExit(1000)) { throw 'Closing the window unexpectedly exited the background application' }
  if (!(Get-Process -Id $corePid -ErrorAction SilentlyContinue)) { throw 'Window close stopped the owned core' }
  $port = (Get-Content $transport -Raw | ConvertFrom-Json).port
  $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -NoProxy -SkipHttpErrorCheck -TimeoutSec 5
  if ($response.StatusCode -ne 401) { throw 'Background core no longer serves its protected transport' }
  # Reopening the installed executable restores the same window/Host, then use
  # the real menu's explicit Quit action instead of treating close as quit.
  Start-Process -FilePath $exe -Wait
  $deadline = (Get-Date).AddSeconds(10)
  do {
    $application.Refresh()
    if ($application.MainWindowHandle -eq 0) { Start-Sleep -Milliseconds 100 }
  } until ($application.MainWindowHandle -ne 0 -or (Get-Date) -gt $deadline)
  if ($application.MainWindowHandle -eq 0) { throw 'Reopening did not restore the background window' }
  & powershell.exe -NoProfile -NonInteractive -STA -File (Join-Path $PSScriptRoot 'quit-windows-test-app.ps1') -ApplicationId $application.Id
  if ($LASTEXITCODE -ne 0) { throw 'Application Quit menu could not be invoked' }
  if (!$application.WaitForExit(20000)) { throw 'Application did not exit after explicit Quit' }
  Start-Sleep -Milliseconds 500
  if (Get-Process -Id $corePid -ErrorAction SilentlyContinue) { throw 'Owned core survived application exit' }
} finally {
  if (!$application.HasExited) { Stop-Process -Id $application.Id -Force }
  if ($corePid -and (Get-Process -Id $corePid -ErrorAction SilentlyContinue)) { Stop-Process -Id $corePid -Force }
}
$uninstall = Start-Process -FilePath (Join-Path $install 'unins000.exe') -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') -Wait -PassThru
if ($uninstall.ExitCode -ne 0 -or (Test-Path $exe)) { throw 'Silent uninstall failed' }
if (!(Test-Path $sentinel)) { throw 'Uninstall removed user data' }
$report = @{ status = 'pass'; update = $updateReport; checks = @('silent per-user installation into a path with spaces', 'installed app.asar and complete runtime match package', 'restart icon completes an external update and retains a complete previous-app backup', 'updated app.asar and complete runtime match package', 'bundled Node runs without system Node', 'updated application automatically creates a native window and owned core', 'closing the window preserves the app and protected Host transport', 'reopening restores the same application window', 'explicit Quit through the real application menu releases its core', 'silent uninstall preserves user data') }
$report | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $root '.test-data/windows-installer-report.json')
$report | ConvertTo-Json -Depth 4 | Write-Output
