param(
  [string]$EvidencePath
)

$ErrorActionPreference = 'Stop'
$startedAt = (Get-Date).ToUniversalTime()
if ([string]::IsNullOrWhiteSpace($EvidencePath) -and -not [string]::IsNullOrWhiteSpace($env:RELEASE_EVIDENCE_PATH)) {
  $EvidencePath = $env:RELEASE_EVIDENCE_PATH
}

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$envFile = Join-Path $root '.env'
$runId = 'e2e-permissions-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
$logDir = Join-Path (Join-Path $root 'tmp') $runId
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$outputLines = @()
$exitCode = 1
$runningOnWindows = $PSVersionTable.PSEdition -eq 'Desktop' -or $IsWindows

function Write-E2EEvidence {
  param([int]$Code, [object[]]$Lines)
  if ([string]::IsNullOrWhiteSpace($EvidencePath)) { return }

  $textLines = @($Lines | ForEach-Object { "$_" })
  $passedLine = @($textLines | Where-Object { $_ -match 'E2E permissions passed \((\d+) checks\)\.' } | Select-Object -Last 1)
  $passedCount = 0
  if ($passedLine -and $passedLine[0] -match 'E2E permissions passed \((\d+) checks\)\.') {
    $passedCount = [int]$Matches[1]
  }
  $cleanupLine = @($textLines | Where-Object { $_ -match '^cleanup:' } | Select-Object -Last 1)
  $status = if ($Code -eq 0) { 'pass' } else { 'fail' }
  $failureSummary = @()
  if ($Code -ne 0) {
    $failureSummary = @($textLines | Where-Object { $_ -and $_ -notmatch '^cleanup:' } | Select-Object -Last 12)
  }
  $commit = if ($env:GITHUB_SHA) { $env:GITHUB_SHA } elseif ($env:BUILD_SOURCEVERSION) { $env:BUILD_SOURCEVERSION } else { $null }
  $branch = if ($env:GITHUB_REF_NAME) { $env:GITHUB_REF_NAME } elseif ($env:BUILD_SOURCEBRANCHNAME) { $env:BUILD_SOURCEBRANCHNAME } else { 'local' }
  $ciRunId = if ($env:GITHUB_RUN_ID) { $env:GITHUB_RUN_ID } elseif ($env:BUILD_BUILDID) { $env:BUILD_BUILDID } else { 'local' }

  $evidenceFullPath = [IO.Path]::GetFullPath($EvidencePath)
  $evidenceDir = Split-Path -Parent $evidenceFullPath
  if ($evidenceDir) {
    New-Item -ItemType Directory -Force -Path $evidenceDir | Out-Null
  }
  $evidence = [ordered]@{
    schemaVersion = 1
    type = 'e2e-permissions'
    command = 'pnpm e2e:permissions'
    startedAt = $startedAt.ToString('o')
    finishedAt = (Get-Date).ToUniversalTime().ToString('o')
    status = $status
    checksTotal = $passedCount
    passed = if ($Code -eq 0) { $passedCount } else { 0 }
    failed = if ($Code -eq 0) { 0 } else { 1 }
    failureSummary = $failureSummary
    cleanup = if ($cleanupLine) { "$($cleanupLine[0])" } else { $null }
    commit = $commit
    branch = $branch
    runId = $ciRunId
    logDir = $logDir
  }
  $evidence | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $evidenceFullPath -Encoding UTF8
}

function Import-DotEnv {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  foreach ($rawLine in [IO.File]::ReadLines($Path)) {
    $line = $rawLine.Trim()
    if (-not $line -or $line.StartsWith('#')) { continue }
    $parts = $line -split '=', 2
    if ($parts.Count -ne 2 -or $parts[0] -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
      throw "Invalid .env line: $rawLine"
    }
    if ([Environment]::GetEnvironmentVariable($parts[0], 'Process')) { continue }
    $value = $parts[1].Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    [Environment]::SetEnvironmentVariable($parts[0], $value, 'Process')
  }
}

function Wait-HttpOk {
  param([string]$Url, [int]$Seconds = 60, [System.Diagnostics.Process]$Process = $null)
  $deadline = (Get-Date).AddSeconds($Seconds)
  do {
    if ($null -ne $Process -and $Process.HasExited) {
      throw "Process $($Process.Id) exited before $Url became available."
    }
    try {
      $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { return }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  } while ((Get-Date) -lt $deadline)
  throw "Timed out waiting for $Url"
}

function Stop-StartedProcess {
  param([System.Diagnostics.Process]$Process)
  if ($null -eq $Process -or $Process.HasExited) { return }
  try {
    if ($PSVersionTable.PSEdition -eq 'Desktop') {
      $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($Process.Id)" -ErrorAction SilentlyContinue)
      foreach ($child in $children) {
        Stop-StartedProcess (Get-Process -Id $child.ProcessId -ErrorAction SilentlyContinue)
      }
      Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
      return
    }

    $Process.Kill($true)
    $Process.WaitForExit(5000) | Out-Null
  } catch {
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
  }
}

function Start-E2EProcess {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$WorkingDirectory,
    [string]$StandardOutputPath,
    [string]$StandardErrorPath
  )

  $parameters = @{
    FilePath = $FilePath
    ArgumentList = $ArgumentList
    WorkingDirectory = $WorkingDirectory
    PassThru = $true
    RedirectStandardOutput = $StandardOutputPath
    RedirectStandardError = $StandardErrorPath
  }
  if ($runningOnWindows) {
    $parameters.WindowStyle = 'Hidden'
  }
  Start-Process @parameters
}

Import-DotEnv $envFile

$env:API_PORT = if ($env:E2E_API_PORT) { $env:E2E_API_PORT } else { '3100' }
$env:WEB_PORT = if ($env:E2E_WEB_PORT) { $env:E2E_WEB_PORT } else { '5174' }
$env:VITE_API_BASE_URL = "http://127.0.0.1:$($env:API_PORT)"
$env:CORS_ALLOWED_ORIGIN = "http://127.0.0.1:$($env:WEB_PORT)"
$env:WEB_ORIGIN = "http://127.0.0.1:$($env:WEB_PORT)"
$env:SYNC_PLANNER_ENABLED = 'false'
$env:SYNC_AUTO_EXECUTION_ENABLED = 'false'

Push-Location $root
$apiProcess = $null
$webProcess = $null
try {
  pnpm db:wait
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  pnpm db:migrate
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  $apiOut = Join-Path $logDir 'api.out.log'
  $apiErr = Join-Path $logDir 'api.err.log'
  $webOut = Join-Path $logDir 'web.out.log'
  $webErr = Join-Path $logDir 'web.err.log'

  $apiProcess = Start-E2EProcess -FilePath 'pnpm' -ArgumentList @('--filter', '@salary/api', 'run', 'dev') -WorkingDirectory $root -StandardOutputPath $apiOut -StandardErrorPath $apiErr
  Wait-HttpOk "http://127.0.0.1:$($env:API_PORT)/health/ready" 90 $apiProcess

  $webProcess = Start-E2EProcess -FilePath 'pnpm' -ArgumentList @('--filter', '@salary/web', 'exec', 'vite', '--host', '127.0.0.1', '--port', $env:WEB_PORT) -WorkingDirectory $root -StandardOutputPath $webOut -StandardErrorPath $webErr
  Wait-HttpOk "http://127.0.0.1:$($env:WEB_PORT)" 90 $webProcess

  $env:E2E_API_URL = "http://127.0.0.1:$($env:API_PORT)"
  $env:E2E_WEB_URL = "http://127.0.0.1:$($env:WEB_PORT)"
  $env:E2E_LOG_DIR = $logDir
  $outputLines = @(pnpm exec tsx scripts/e2e-permissions.ts 2>&1)
  $exitCode = $LASTEXITCODE
  $outputLines | ForEach-Object { Write-Output $_ }
  exit $exitCode
} finally {
  Write-E2EEvidence $exitCode $outputLines
  Stop-StartedProcess $webProcess
  Stop-StartedProcess $apiProcess
  Pop-Location
}
