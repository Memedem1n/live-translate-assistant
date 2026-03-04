[CmdletBinding()]
param(
  [int]$Runs = 3,
  [string]$VenvPath = ".venv311"
)

$ErrorActionPreference = "Stop"

$venvPython = Join-Path $VenvPath "Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
  throw "Sanal ortam bulunamadi: $venvPython. Once scripts/setup_runtime.ps1 calistirin."
}

Write-Host "[demo] sample clip set hazirlaniyor..."
& $venvPython "scripts/prepare_sample_clips.py" --out-dir "artifacts/bench_clips"

Write-Host "[demo] STT modeller prewarm ediliyor..."
& $venvPython "scripts/prewarm_stt_models.py" --models small.en medium.en large-v3 --device auto

Write-Host "[demo] model sweep baslatiliyor..."
& $venvPython "scripts/model_sweep.py" `
  --manifest "artifacts/bench_clips/manifest.json" `
  --runs $Runs `
  --warmup-runs 1 `
  --stt-device auto `
  --target-stt-ms 800 `
  --target-first-token-ms 900 `
  --target-assist-final-ms 2500

Write-Host "[demo] tamamlandi"
