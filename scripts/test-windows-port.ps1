$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
# A wildcard exclusive bind makes Windows deny the second loopback bind with
# EACCES. This disposable CI socket never changes system port reservations.
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, 0)
$listener.ExclusiveAddressUse = $true
$previousPort = $env:DSH_TEST_DENIED_PORT
try {
  $listener.Start()
  $env:DSH_TEST_DENIED_PORT = [string]$listener.LocalEndpoint.Port
  Write-Output ("Exclusive Windows test port: " + $env:DSH_TEST_DENIED_PORT)
  & node --test (Join-Path $root 'tests/runtime.test.ts')
  if ($LASTEXITCODE -ne 0) { throw 'Cached-port recovery regression failed' }
} finally {
  $env:DSH_TEST_DENIED_PORT = $previousPort
  $listener.Stop()
}
