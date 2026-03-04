[CmdletBinding()]
param(
  [string]$VenvPath = ".venvtrain311",
  [switch]$CpuOnly,
  [switch]$SkipPythonInstall,
  [switch]$SkipAxolotl,
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

  if ($SkipAxolotl) {
    Write-Step "axolotl kurulumu atlandi."
    return
  }

  Write-Step "axolotl kurulumu deneniyor..."
  try {
    & $PythonExe -m pip install --upgrade axolotl
  } catch {
    Write-WarnLine "axolotl kurulumu basarisiz oldu. Bu durumda sadece dataset hazirlama adimlari calisir."
  }
}

function Verify-Env {
  param([string]$PythonExe)

  $verify = @'
import importlib.util
import json

payload = {"ok": True}
try:
    import torch
    payload["torch_version"] = str(torch.__version__)
    payload["cuda_available"] = bool(torch.cuda.is_available())
    payload["cuda_device_count"] = int(torch.cuda.device_count()) if torch.cuda.is_available() else 0
except Exception as exc:
    payload["ok"] = False
    payload["torch_error"] = str(exc)

payload["axolotl_installed"] = importlib.util.find_spec("axolotl") is not None
payload["bitsandbytes_installed"] = importlib.util.find_spec("bitsandbytes") is not None
print(json.dumps(payload, ensure_ascii=False))
'@
  & $PythonExe -c $verify
}

Ensure-Winget
Ensure-Python311
$venvPython = Ensure-Venv
Install-PipBase -PythonExe $venvPython
Install-Torch -PythonExe $venvPython
Install-TrainDeps -PythonExe $venvPython
Write-Step "Dogrulama calisiyor..."
Verify-Env -PythonExe $venvPython
Write-Step "Tamamlandi."
Write-Host "Kullanilacak train Python: $((Resolve-Path $venvPython).Path)"

