$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
# This runs only on the disposable Windows CI runner. Reserve one previously
# free port for this test, then remove exactly that active reservation.
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
try {
  $listener.Start()
  $reservedPort = $listener.LocalEndpoint.Port
} finally { $listener.Stop() }
$created = $false
$previousPort = $env:DSH_TEST_EXCLUDED_PORT
try {
  & netsh interface ipv4 add excludedportrange protocol=tcp startport=$reservedPort numberofports=1 store=active
  if ($LASTEXITCODE -ne 0) { throw 'Could not reserve the isolated test port' }
  $created = $true
  $env:DSH_TEST_EXCLUDED_PORT = [string]$reservedPort
  & node --test (Join-Path $root 'tests/runtime.test.ts')
  if ($LASTEXITCODE -ne 0) { throw 'Cached-port recovery regression failed' }
} finally {
  $env:DSH_TEST_EXCLUDED_PORT = $previousPort
  if ($created) {
    & netsh interface ipv4 delete excludedportrange protocol=tcp startport=$reservedPort numberofports=1 store=active
    if ($LASTEXITCODE -ne 0) { throw 'Could not remove the isolated test port reservation' }
  }
}
