[CmdletBinding()]
param(
  [ValidateSet("full", "safe")]
  [string]$Profile = "full"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
  throw "ollama komutu bulunamadi. Once scripts/setup_runtime.ps1 calistirin."
}

$profiles = @{
  "full" = @(
    "qwen2.5:3b-instruct-q4_K_M",
    "qwen2.5:7b-instruct-q4_K_M",
    "qwen2.5:14b-instruct-q4_K_M"
  )
  "safe" = @(
    "qwen2.5:7b-instruct-q4_K_M",
    "qwen2.5:14b-instruct-q4_K_M"
  )
}

$sizeHintsGb = @{
  "qwen2.5:3b-instruct-q4_K_M" = 1.9
  "qwen2.5:7b-instruct-q4_K_M" = 4.7
  "qwen2.5:14b-instruct-q4_K_M" = 9.0
}

$models = $profiles[$Profile]
$expected = ($models | ForEach-Object { $sizeHintsGb[$_] } | Measure-Object -Sum).Sum

Write-Host "[models] profile=$Profile expected_llm_gb=~$expected"

foreach ($model in $models) {
  Write-Host "[models] pulling $model"
  ollama pull $model
}

Write-Host "[models] ready"
ollama list
