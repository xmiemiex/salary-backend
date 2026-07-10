$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'

if (-not (Test-Path -LiteralPath $envFile)) {
  throw '.env is missing. Copy .env.example to .env and replace the encryption-key placeholder.'
}

Get-Content -LiteralPath $envFile | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith('#')) { return }
  $parts = $line -split '=', 2
  if ($parts.Count -ne 2 -or $parts[0] -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
    throw "Invalid .env line: $_"
  }
  $value = $parts[1].Trim()
  if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  [Environment]::SetEnvironmentVariable($parts[0], $value, 'Process')
}

pnpm db:wait
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
pnpm db:migrate
if ($LASTEXITCODE -ne 0) { throw 'Database migration failed; API and Web were not started.' }

pnpm --parallel --filter '@salary/api' --filter '@salary/web' run dev
exit $LASTEXITCODE
