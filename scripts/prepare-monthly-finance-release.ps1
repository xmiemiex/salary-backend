param([string]$OutputDirectory = 'tmp/monthly-finance-release')
$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $taskRoot
$taskRevision = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve release revision.' }
if (git status --porcelain) { throw 'Commit the reviewed changes before preparing a release archive.' }
$taskOutput = [IO.Path]::GetFullPath((Join-Path $taskRoot $OutputDirectory))
if (-not $taskOutput.StartsWith($taskRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Output must remain inside this worktree.' }
New-Item -ItemType Directory -Force -Path $taskOutput | Out-Null
$taskArchive = Join-Path $taskOutput "monthly-finance-$taskRevision.tar.gz"
git archive --format=tar.gz --output=$taskArchive $taskRevision
if ($LASTEXITCODE -ne 0) { throw 'Archive creation failed.' }
$taskHash = (Get-FileHash -LiteralPath $taskArchive -Algorithm SHA256).Hash.ToLowerInvariant()
$taskEvidencePath = Join-Path $taskRoot 'tmp/monthly-finance-rework/browser-evidence.json'
if (-not (Test-Path -LiteralPath $taskEvidencePath)) { throw 'Run the built browser acceptance check first.' }
$taskEvidence = Get-Content -LiteralPath $taskEvidencePath -Raw | ConvertFrom-Json
if ($taskEvidence.commit -ne $taskRevision -or $taskEvidence.dirty) { throw 'Browser evidence must match the current commit.' }
$taskEvidenceFiles = @('browser-evidence.json') + @($taskEvidence.screenshots) + @('details-page-2.png')
$taskEvidenceHashes = @{}
foreach ($taskEvidenceFile in $taskEvidenceFiles) {
  $taskEvidenceSource = Join-Path (Split-Path $taskEvidencePath) $taskEvidenceFile
  Copy-Item -LiteralPath $taskEvidenceSource -Destination (Join-Path $taskOutput $taskEvidenceFile) -Force
  $taskEvidenceHashes[$taskEvidenceFile] = (Get-FileHash -LiteralPath $taskEvidenceSource -Algorithm SHA256).Hash.ToLowerInvariant()
}
$taskManifest = [ordered]@{
  browserEvidence = $taskEvidenceHashes
  buildHashes = $taskEvidence.buildHashes
  commit = $taskRevision
  branch = (git branch --show-current).Trim()
  sourceArchive = [IO.Path]::GetFileName($taskArchive)
  sha256 = $taskHash
  preparedAt = [DateTime]::UtcNow.ToString('o')
  scope = 'Local reviewed candidate; production deployment is not authorized by this manifest.'
  productionCompose = 'docker-compose.prod.yml'
  apiDockerfile = 'apps/api/Dockerfile'
  webDockerfile = 'apps/web/Dockerfile'
  worker = 'DashboardRefreshWorker inside the existing API process; no extra daemon'
  plannerEnabled = $false
  automaticScheduledExecutionEnabled = $false
  migrations = @('20260905010000_monthly_finance_refresh','20260905011000_inventory_checkpoint','20260905012000_monthly_write_lock','20260905013000_adpos_monthly_fee_consistency','20260905014000_preserve_unambiguous_adpos_rates','20260905015000_guard_inflight_financial_writes','20260905016000_resumable_inventory')
}
$taskManifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $taskOutput 'manifest.json') -Encoding utf8
"$taskHash  $([IO.Path]::GetFileName($taskArchive))" | Set-Content -LiteralPath (Join-Path $taskOutput 'SHA256SUMS') -Encoding ascii
Write-Output "Prepared commit $taskRevision at $taskOutput"
