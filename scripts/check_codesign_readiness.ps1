param(
  [string]$Repo = "",
  [switch]$Strict
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-RepoName {
  param([string]$GivenRepo)

  if (-not [string]::IsNullOrWhiteSpace($GivenRepo)) {
    return $GivenRepo
  }

  $resolved = gh repo view --json nameWithOwner --jq .nameWithOwner
  if ([string]::IsNullOrWhiteSpace($resolved)) {
    throw "Failed to resolve repository name from gh CLI."
  }
  return $resolved.Trim()
}

function Write-Status {
  param(
    [string]$Label,
    [bool]$Ok,
    [string]$Detail
  )
  $prefix = if ($Ok) { "[OK]" } else { "[MISSING]" }
  Write-Host "$prefix $Label - $Detail"
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw "gh CLI is required."
}

$repoName = Resolve-RepoName -GivenRepo $Repo

$secrets = gh secret list --repo $repoName --json name | ConvertFrom-Json
$secretNames = @{}
foreach ($item in $secrets) {
  $secretNames[$item.name] = $true
}

$requiredSecrets = @("WINDOWS_CERT_PFX_BASE64", "WINDOWS_CERT_PASSWORD")
$missing = New-Object System.Collections.Generic.List[string]

foreach ($name in $requiredSecrets) {
  $exists = $secretNames.ContainsKey($name)
  $detail = if ($exists) { "present" } else { "not set" }
  Write-Status -Label "Secret $name" -Ok $exists -Detail $detail
  if (-not $exists) {
    [void]$missing.Add($name)
  }
}

$iconExists = Test-Path "build/icon.ico"
$iconDetail = if ($iconExists) { "present" } else { "missing" }
Write-Status -Label "build/icon.ico" -Ok $iconExists -Detail $iconDetail

$workflowExists = Test-Path ".github/workflows/windows-installer.yml"
$workflowDetail = if ($workflowExists) { "present" } else { "missing" }
Write-Status -Label "windows-installer workflow" -Ok $workflowExists -Detail $workflowDetail

$canSign = $missing.Count -eq 0
Write-Host ""
Write-Host "Repository: $repoName"
Write-Host "Signing ready: $canSign"

if ($Strict -and -not $canSign) {
  throw "Signing prerequisites are missing: $($missing -join ', ')"
}
