[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ScriptPath,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ScriptArgs
)

$ErrorActionPreference = "Stop"

$venvPython = Join-Path ".venv311" "Scripts\python.exe"
$pythonCmd = if (Test-Path $venvPython) { $venvPython } else { "python" }

function Add-ToPathIfExists {
  param([string]$Candidate)
  if (Test-Path $Candidate) {
    $env:Path = "$Candidate;$env:Path"
  }
}

Add-ToPathIfExists "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.1\bin"
Add-ToPathIfExists "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.6\bin"
Add-ToPathIfExists "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.4\bin"

$venvNvidia = Join-Path ".venv311" "Lib\site-packages\nvidia"
if (Test-Path $venvNvidia) {
  Get-ChildItem -Path $venvNvidia -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $binDir = Join-Path $_.FullName "bin"
    Add-ToPathIfExists $binDir
  }
}

Write-Host "[py] using: $pythonCmd"
& $pythonCmd -u $ScriptPath @ScriptArgs
exit $LASTEXITCODE
