[CmdletBinding()]
param(
  [string]$VenvPath = ".venv311",
  [switch]$SkipOllamaInstall,
  [switch]$SkipPythonInstall
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host "[setup] $Message" -ForegroundColor Cyan
}

function Ensure-Winget {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "winget bulunamadi. Microsoft App Installer kurulu olmali."
  }
}

function Ensure-Ollama {
  if ($SkipOllamaInstall) {
    Write-Step "Ollama kurulum adimi atlandi."
    return
  }

  if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    Write-Step "Ollama kuruluyor..."
    winget install --id Ollama.Ollama -e --source winget --accept-package-agreements --accept-source-agreements | Out-Host
  } else {
    Write-Step "Ollama zaten kurulu."
  }

  if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    $candidate = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
    if (Test-Path $candidate) {
      $env:Path = "$($env:Path);$(Split-Path $candidate)"
    }
  }

  if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    throw "Ollama komutu bulunamadi. PATH yenilenmesi icin terminali yeniden acip tekrar deneyin."
  }

  try {
    $null = Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 2
    Write-Step "Ollama servisi hazir."
  } catch {
    Write-Step "Ollama servisi baslatiliyor..."
    Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden | Out-Null
    Start-Sleep -Seconds 4
  }
}

function Ensure-Python311 {
  if ($SkipPythonInstall) {
    Write-Step "Python 3.11 kurulum adimi atlandi."
    return
  }

  $python311 = $null
  try {
    $python311 = & py -3.11 -c "import sys; print(sys.executable)"
  } catch {
    $python311 = $null
  }

  if (-not $python311) {
    Write-Step "Python 3.11 kuruluyor..."
    winget install --id Python.Python.3.11 -e --source winget --accept-package-agreements --accept-source-agreements | Out-Host
    $python311 = & py -3.11 -c "import sys; print(sys.executable)"
  } else {
    Write-Step "Python 3.11 zaten kurulu."
  }

  if (-not $python311) {
    throw "Python 3.11 bulunamadi."
  }
}

function Ensure-VenvAndDeps {
  $venvPython = Join-Path $VenvPath "Scripts\python.exe"
  if (-not (Test-Path $venvPython)) {
    Write-Step "Sanal ortam olusturuluyor: $VenvPath"
    & py -3.11 -m venv $VenvPath
  } else {
    Write-Step "Sanal ortam zaten var: $VenvPath"
  }

  Write-Step "pip guncelleniyor..."
  & $venvPython -m pip install --upgrade pip

  Write-Step "faster-whisper kuruluyor..."
  & $venvPython -m pip install faster-whisper

  Write-Step "Kurulum dogrulaniyor..."
  & $venvPython -c "import faster_whisper; print('faster_whisper_ok=1')"
}

Ensure-Winget
Ensure-Ollama
Ensure-Python311
Ensure-VenvAndDeps

Write-Step "Tamamlandi."
Write-Host "Kullanilacak Python: $((Resolve-Path (Join-Path $VenvPath 'Scripts\python.exe')).Path)"
