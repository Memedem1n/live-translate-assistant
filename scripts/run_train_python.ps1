[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ScriptPath,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ScriptArgs,

  [string]$VenvPath = ".venvtrain311"
)

$ErrorActionPreference = "Stop"

$venvPython = Join-Path $VenvPath "Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
  throw "Train venv bulunamadi: $venvPython. Once npm run finetune:setup-env calistirin."
}

function Add-ToPathIfExists {
  param([string]$Candidate)
  if (Test-Path $Candidate) {
    $env:Path = "$Candidate;$env:Path"
  }
}

Add-ToPathIfExists "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.1\bin"
Add-ToPathIfExists "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.6\bin"
Add-ToPathIfExists "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.4\bin"

$venvNvidia = Join-Path $VenvPath "Lib\site-packages\nvidia"
if (Test-Path $venvNvidia) {
  Get-ChildItem -Path $venvNvidia -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $binDir = Join-Path $_.FullName "bin"
    Add-ToPathIfExists $binDir
  }
}

Write-Host "[train-py] using: $venvPython"
& $venvPython -u $ScriptPath @ScriptArgs
exit $LASTEXITCODE

