[CmdletBinding()]
param(
  [string]$VenvPath = ".venvtrain311",
  [switch]$CpuOnly,
  [switch]$SkipPythonInstall,
  [switch]$Recreate
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host "[train-setup] $Message" -ForegroundColor Cyan
}

function Write-WarnLine {
  param([string]$Message)
  Write-Host "[train-setup][warn] $Message" -ForegroundColor Yellow
}

function Ensure-Winget {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "winget bulunamadi. Microsoft App Installer kurulu olmali."
  }
}

function Ensure-Python311 {
  if ($SkipPythonInstall) {
    Write-Step "Python 3.11 kurulum adimi atlandi."
    return
  }

  $python311 = $null
  try {
    $python311 = (& py -3.11 -c "import sys; print(sys.executable)" 2>$null)
  } catch {
    $python311 = $null
  }

  if (-not $python311) {
    Write-Step "Python 3.11 kuruluyor..."
    winget install --id Python.Python.3.11 -e --source winget --accept-package-agreements --accept-source-agreements | Out-Host
    $python311 = (& py -3.11 -c "import sys; print(sys.executable)")
  } else {
    Write-Step "Python 3.11 zaten kurulu."
  }

  if (-not $python311) {
    throw "Python 3.11 bulunamadi."
  }
}

function Ensure-Venv {
  $venvPython = Join-Path $VenvPath "Scripts\python.exe"
  if ($Recreate -and (Test-Path $VenvPath)) {
    Write-Step "Var olan train sanal ortam siliniyor: $VenvPath"
    Remove-Item -Recurse -Force $VenvPath
  }

  if (-not (Test-Path $venvPython)) {
    Write-Step "Train sanal ortam olusturuluyor: $VenvPath"
    & py -3.11 -m venv $VenvPath
  } else {
    Write-Step "Train sanal ortam zaten var: $VenvPath"
  }

  return (Join-Path $VenvPath "Scripts\python.exe")
}

function Install-PipBase {
  param([string]$PythonExe)
  Write-Step "pip/setuptools/wheel guncelleniyor..."
  & $PythonExe -m pip install --upgrade pip setuptools wheel
}

function Install-Torch {
  param([string]$PythonExe)

  if ($CpuOnly) {
    Write-Step "CPU torch wheel kuruluyor..."
    & $PythonExe -m pip install --upgrade torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu
    return
  }

  Write-Step "CUDA torch wheel kuruluyor (cu126)..."
  try {
    & $PythonExe -m pip install --upgrade torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu126
  } catch {
    Write-WarnLine "cu126 kurulumu basarisiz oldu, varsayilan torch kurulumu denenecek."
    & $PythonExe -m pip install --upgrade torch torchvision torchaudio
  }
}

function Install-TrainDeps {
  param([string]$PythonExe)

  Write-Step "Temel train kutuphaneleri kuruluyor..."
  & $PythonExe -m pip install --upgrade accelerate datasets peft sentencepiece safetensors transformers trl

  Write-Step "bitsandbytes kurulumu deneniyor..."
  try {
    & $PythonExe -m pip install --upgrade bitsandbytes
  } catch {
    Write-WarnLine "bitsandbytes kurulumu basarisiz oldu. 4-bit egitim bu ortamda devre disi olabilir."
  }
}

function Verify-Env {
  param(
    [string]$PythonExe,
    [string]$BackendName
  )

  $verifyScript = Join-Path (Get-Location) "scripts\check_train_env.py"
  if (-not (Test-Path $verifyScript)) {
    throw "Dogrulama scripti bulunamadi: $verifyScript"
  }

  $verifyOutput = & $PythonExe $verifyScript --backend $BackendName 2>&1
  if ($LASTEXITCODE -ne 0) {
    $details = ($verifyOutput | Out-String).Trim()
    throw "Train ortam dogrulamasi calistirilamadi. $details"
  }

  $verifyText = ($verifyOutput | Out-String).Trim()
  if (-not $verifyText) {
    throw "Train ortam dogrulamasi bos cikti verdi."
  }

  try {
    $payload = $verifyText | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw "Train ortam dogrulamasi JSON parse edilemedi. Cikti: $verifyText"
  }

  $status = [ordered]@{
    ok               = [bool]$payload.ok
    backend          = $BackendName
    reasons          = @($payload.reasons)
    payload          = $payload
  }

  Write-Host ($status | ConvertTo-Json -Depth 6 -Compress)

  if (-not [bool]$payload.ok) {
    $reasonText = if ($payload.reasons) { [string]::Join(', ', @($payload.reasons)) } else { "unknown" }
    throw "Train ortam dogrulamasi basarisiz: $reasonText"
  }

  return $status
}

Ensure-Winget
Ensure-Python311
$venvPython = Ensure-Venv
Install-PipBase -PythonExe $venvPython
Install-Torch -PythonExe $venvPython
Install-TrainDeps -PythonExe $venvPython
Write-Step "Dogrulama calisiyor..."
Verify-Env -PythonExe $venvPython -BackendName "hf" | Out-Null
Write-Step "Tamamlandi."
Write-Host "Kullanilacak train Python: $((Resolve-Path $venvPython).Path)"
