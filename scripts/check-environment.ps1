param(
  [string]$EvidencePath
)

$ErrorActionPreference = 'Continue'
$startedAt = (Get-Date).ToUniversalTime()
if ([string]::IsNullOrWhiteSpace($EvidencePath) -and -not [string]::IsNullOrWhiteSpace($env:RELEASE_EVIDENCE_PATH)) {
  $EvidencePath = $env:RELEASE_EVIDENCE_PATH
}

$checks = [System.Collections.Generic.List[object]]::new()

function Add-Check {
  param(
    [string]$Name,
    [bool]$Passed,
    [string]$Details,
    [bool]$Required = $true
  )

  $checks.Add([pscustomobject]@{
    Check = $Name
    Status = if ($Passed) { 'OK' } elseif ($Required) { 'FAIL' } else { 'INFO' }
    Details = $Details
    Required = $Required
  })
}

function Get-CommandVersion {
  param([string]$Command, [string[]]$Arguments)

  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
    return $null
  }

  $output = & $Command @Arguments 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  return (($output | Select-Object -First 1) -as [string]).Trim()
}

function Get-LocalConfiguration {
  param([string]$EnvPath)

  $defaults = [ordered]@{
    POSTGRES_USER = 'salary_dev'
    POSTGRES_DB = 'salary_settlement'
    POSTGRES_PORT = '5432'
    API_PORT = '3000'
    WEB_PORT = '5173'
    SYNC_PLANNER_ENABLED = 'false'
    SYNC_PLANNER_DAY = '10'
    SYNC_PLANNER_HOUR = '9'
    SYNC_PLANNER_TIMEZONE = 'Asia/Shanghai'
    SYNC_AUTO_EXECUTION_ENABLED = 'false'
    SYNC_AUTO_EXECUTION_POLL_SECONDS = '60'
    SYNC_AUTO_EXECUTION_BATCH_SIZE = '2'
    SYNC_AUTO_EXECUTION_MAX_ATTEMPTS = '3'
    SYNC_AUTO_EXECUTION_LEASE_SECONDS = '900'
    SYNC_AUTO_EXECUTION_RETRY_BASE_SECONDS = '300'
  }
  $values = @{}
  $processOverrides = @{}

  foreach ($name in $defaults.Keys) {
    $processValue = [Environment]::GetEnvironmentVariable($name, 'Process')
    $processOverrides[$name] = $null -ne $processValue
    if ($null -ne $processValue) {
      $values[$name] = $processValue
    }
  }

  if (Test-Path -LiteralPath $EnvPath) {
    $lineNumber = 0
    foreach ($rawLine in [IO.File]::ReadLines($EnvPath)) {
      $lineNumber++
      $line = $rawLine.Trim()
      if (-not $line -or $line.StartsWith('#')) { continue }

      $parts = $line -split '=', 2
      if ($parts.Count -ne 2 -or $parts[0] -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
        throw "Invalid .env syntax at line $lineNumber."
      }

      $name = $parts[0]
      if (-not $defaults.Contains($name) -or $processOverrides[$name]) { continue }

      $value = $parts[1].Trim()
      if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        $value = $value.Substring(1, $value.Length - 2)
      }
      $values[$name] = $value
    }
  }

  foreach ($name in $defaults.Keys) {
    if (-not $values.ContainsKey($name) -or [string]::IsNullOrWhiteSpace($values[$name])) {
      $values[$name] = $defaults[$name]
    }
  }

  return $values
}

function ConvertTo-Port {
  param([string]$Name, [string]$Value)

  $port = 0
  if (-not [int]::TryParse($Value, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
    throw "$Name must be an integer between 1 and 65535."
  }
  return $port
}

function ConvertTo-BoundedInteger {
  param([string]$Name, [string]$Value, [int]$Minimum, [int]$Maximum)
  $number = 0
  if (-not [int]::TryParse($Value, [ref]$number) -or $number -lt $Minimum -or $number -gt $Maximum) {
    throw "$Name must be an integer between $Minimum and $Maximum."
  }
  return $number
}

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$envPath = Join-Path $projectRoot '.env'
$envExists = Test-Path -LiteralPath $envPath
$configuration = Get-LocalConfiguration $envPath
$postgresUser = $configuration.POSTGRES_USER
$postgresDatabase = $configuration.POSTGRES_DB
$postgresPort = ConvertTo-Port 'POSTGRES_PORT' $configuration.POSTGRES_PORT
$apiPort = ConvertTo-Port 'API_PORT' $configuration.API_PORT
$webPort = ConvertTo-Port 'WEB_PORT' $configuration.WEB_PORT
$plannerEnabled = $configuration.SYNC_PLANNER_ENABLED
if ($plannerEnabled -notin @('true', 'false')) { throw 'SYNC_PLANNER_ENABLED must be true or false.' }
$plannerDay = ConvertTo-BoundedInteger 'SYNC_PLANNER_DAY' $configuration.SYNC_PLANNER_DAY 1 28
$plannerHour = ConvertTo-BoundedInteger 'SYNC_PLANNER_HOUR' $configuration.SYNC_PLANNER_HOUR 0 23
if ($configuration.SYNC_PLANNER_TIMEZONE -ne 'Asia/Shanghai') { throw 'SYNC_PLANNER_TIMEZONE must be Asia/Shanghai.' }
$autoExecutionEnabled = $configuration.SYNC_AUTO_EXECUTION_ENABLED
if ($autoExecutionEnabled -notin @('true', 'false')) { throw 'SYNC_AUTO_EXECUTION_ENABLED must be true or false.' }
$autoPollSeconds = ConvertTo-BoundedInteger 'SYNC_AUTO_EXECUTION_POLL_SECONDS' $configuration.SYNC_AUTO_EXECUTION_POLL_SECONDS 1 3600
$autoBatchSize = ConvertTo-BoundedInteger 'SYNC_AUTO_EXECUTION_BATCH_SIZE' $configuration.SYNC_AUTO_EXECUTION_BATCH_SIZE 1 10
$autoMaxAttempts = ConvertTo-BoundedInteger 'SYNC_AUTO_EXECUTION_MAX_ATTEMPTS' $configuration.SYNC_AUTO_EXECUTION_MAX_ATTEMPTS 1 5
$autoLeaseSeconds = ConvertTo-BoundedInteger 'SYNC_AUTO_EXECUTION_LEASE_SECONDS' $configuration.SYNC_AUTO_EXECUTION_LEASE_SECONDS 2 86400
$autoRetryBaseSeconds = ConvertTo-BoundedInteger 'SYNC_AUTO_EXECUTION_RETRY_BASE_SECONDS' $configuration.SYNC_AUTO_EXECUTION_RETRY_BASE_SECONDS 1 86400
if ($autoLeaseSeconds -le $autoPollSeconds) { throw 'SYNC_AUTO_EXECUTION_LEASE_SECONDS must be greater than SYNC_AUTO_EXECUTION_POLL_SECONDS.' }

$nodeVersion = Get-CommandVersion 'node' @('--version')
Add-Check 'Node.js' ($null -ne $nodeVersion) $(if ($nodeVersion) { $nodeVersion } else { 'command not found' })

$pnpmVersion = Get-CommandVersion 'pnpm' @('--version')
Add-Check 'pnpm' ($null -ne $pnpmVersion) $(if ($pnpmVersion) { $pnpmVersion } else { 'command not found' })

$dockerVersion = Get-CommandVersion 'docker' @('--version')
Add-Check 'Docker CLI' ($null -ne $dockerVersion) $(if ($dockerVersion) { $dockerVersion } else { 'command not found' })

$composeVersion = if ($dockerVersion) { Get-CommandVersion 'docker' @('compose', 'version') } else { $null }
Add-Check 'Docker Compose' ($null -ne $composeVersion) $(if ($composeVersion) { $composeVersion } else { 'docker compose unavailable' })

$daemonVersion = if ($dockerVersion) { Get-CommandVersion 'docker' @('info', '--format', '{{.ServerVersion}}') } else { $null }
Add-Check 'Docker daemon' ($null -ne $daemonVersion) $(if ($daemonVersion) { "server $daemonVersion" } else { 'not running or inaccessible' })

Add-Check 'PostgreSQL config' $true "user=$postgresUser database=$postgresDatabase port=$postgresPort" $false
Add-Check 'API config' $true "port=$apiPort" $false
Add-Check 'Web config' $true "port=$webPort" $false
Add-Check 'Sync planner config' $true "enabled=$plannerEnabled day=$plannerDay hour=$plannerHour timezone=Asia/Shanghai" $false
Add-Check 'Sync auto execution config' $true "enabled=$autoExecutionEnabled pollSeconds=$autoPollSeconds batchSize=$autoBatchSize maxAttempts=$autoMaxAttempts leaseSeconds=$autoLeaseSeconds retryBaseSeconds=$autoRetryBaseSeconds" $false

$configuredPorts = [ordered]@{
  PostgreSQL = $postgresPort
  API = $apiPort
  Web = $webPort
}
foreach ($service in $configuredPorts.Keys) {
  $port = $configuredPorts[$service]
  $netTcpCommand = Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue
  if ($netTcpCommand) {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
    if ($listeners.Count -eq 0) {
      Add-Check "$service port $port" $true 'available' $false
      continue
    }

    $processNames = @($listeners | ForEach-Object {
      (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName
    } | Where-Object { $_ } | Sort-Object -Unique)
    $details = if ($processNames.Count) { 'listening: ' + ($processNames -join ', ') } else { 'listening' }
    Add-Check "$service port $port" $true $details $false
    continue
  }

  $client = [System.Net.Sockets.TcpClient]::new()
  $listening = $false
  try {
    $connectTask = $client.ConnectAsync('127.0.0.1', $port)
    $listening = $connectTask.Wait(500) -and $client.Connected
  } catch {
    $listening = $false
  } finally {
    $client.Dispose()
  }
  Add-Check "$service port $port" $true $(if ($listening) { 'listening' } else { 'available' }) $false
}

Add-Check '.env' $envExists $(if ($envExists) { 'present' } else { 'missing' })

$postgresHealthy = $false
$databaseReady = $false
if ($composeVersion -and $daemonVersion -and $envExists) {
  $containerId = (& docker compose ps -q postgres 2>$null | Select-Object -First 1)
  if ($containerId) {
    $health = (& docker inspect --format '{{.State.Health.Status}}' $containerId 2>$null | Select-Object -First 1)
    $postgresHealthy = $health -eq 'healthy'
    Add-Check 'PostgreSQL container' $postgresHealthy $(if ($health) { $health } else { 'health unavailable' })

    & docker compose exec -T postgres pg_isready -U $postgresUser -d $postgresDatabase *> $null
    $databaseReady = $LASTEXITCODE -eq 0
    Add-Check 'PostgreSQL connection' $databaseReady $(if ($databaseReady) { 'accepting connections' } else { 'not ready' })
  } else {
    Add-Check 'PostgreSQL container' $false 'not created or not running'
    Add-Check 'PostgreSQL connection' $false 'container unavailable'
  }
} else {
  Add-Check 'PostgreSQL container' $false 'prerequisite check failed'
  Add-Check 'PostgreSQL connection' $false 'prerequisite check failed'
}

$checks | Select-Object Check, Status, Details | Format-Table -AutoSize

$requiredFailures = @($checks | Where-Object { $_.Required -and $_.Status -eq 'FAIL' })
$status = if ($requiredFailures.Count -eq 0) { 'pass' } else { 'fail' }

if (-not [string]::IsNullOrWhiteSpace($EvidencePath)) {
  $evidenceFullPath = [IO.Path]::GetFullPath($EvidencePath)
  $evidenceDir = Split-Path -Parent $evidenceFullPath
  if ($evidenceDir) {
    New-Item -ItemType Directory -Force -Path $evidenceDir | Out-Null
  }

  $checkedVariables = @(
    'POSTGRES_USER',
    'POSTGRES_DB',
    'POSTGRES_PORT',
    'API_PORT',
    'WEB_PORT',
    'SYNC_PLANNER_ENABLED',
    'SYNC_PLANNER_DAY',
    'SYNC_PLANNER_HOUR',
    'SYNC_PLANNER_TIMEZONE',
    'SYNC_AUTO_EXECUTION_ENABLED',
    'SYNC_AUTO_EXECUTION_POLL_SECONDS',
    'SYNC_AUTO_EXECUTION_BATCH_SIZE',
    'SYNC_AUTO_EXECUTION_MAX_ATTEMPTS',
    'SYNC_AUTO_EXECUTION_LEASE_SECONDS',
    'SYNC_AUTO_EXECUTION_RETRY_BASE_SECONDS'
  )
  $safeChecks = @($checks | ForEach-Object {
    [pscustomobject]@{
      check = $_.Check
      status = $_.Status
      required = $_.Required
      details = $_.Details
    }
  })
  $environmentName = if ($env:APP_ENV) { $env:APP_ENV } elseif ($env:NODE_ENV) { $env:NODE_ENV } else { 'development' }
  $evidence = [ordered]@{
    schemaVersion = 1
    type = 'env-check'
    command = 'pnpm env:check'
    startedAt = $startedAt.ToString('o')
    finishedAt = (Get-Date).ToUniversalTime().ToString('o')
    status = $status
    environment = $environmentName
    checkedVariables = $checkedVariables
    categories = @('runtime', 'docker', 'database', 'local-ports', 'sync-configuration')
    missing = @($checks | Where-Object { $_.Check -eq '.env' -and $_.Status -eq 'FAIL' } | ForEach-Object { $_.Check })
    invalid = @($requiredFailures | ForEach-Object { $_.Check })
    requiredCheckCount = @($checks | Where-Object { $_.Required }).Count
    totalCheckCount = $checks.Count
    checks = $safeChecks
  }
  $evidence | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $evidenceFullPath -Encoding UTF8
}

if ($requiredFailures.Count -gt 0) {
  exit 1
}

exit 0
