$ErrorActionPreference = 'Stop'

$timeoutSeconds = if ($env:DB_WAIT_TIMEOUT_SECONDS) { [int]$env:DB_WAIT_TIMEOUT_SECONDS } else { 90 }
$deadline = (Get-Date).AddSeconds($timeoutSeconds)

do {
  $health = docker compose ps --format json postgres | ConvertFrom-Json
  if ($health.Health -eq 'healthy') {
    Write-Host 'PostgreSQL is healthy.'
    exit 0
  }
  Start-Sleep -Seconds 2
} while ((Get-Date) -lt $deadline)

Write-Error "PostgreSQL did not become healthy within $timeoutSeconds seconds. Run 'pnpm db:status' for details."
exit 1
