param(
  [Parameter(Mandatory = $true)]
  [string]$PfxPath,

  [string]$Repo = "",

  [string]$Password = ""
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

function Read-PasswordFromPrompt {
  $secure = Read-Host "Enter PFX password" -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw "gh CLI is required."
}

$repoName = Resolve-RepoName -GivenRepo $Repo
$resolvedPfxPath = Resolve-Path $PfxPath -ErrorAction Stop

if (-not [System.IO.File]::Exists($resolvedPfxPath.Path)) {
  throw "PFX file not found: $PfxPath"
}

$plainPassword = $Password
if ([string]::IsNullOrWhiteSpace($plainPassword)) {
  $plainPassword = Read-PasswordFromPrompt
}

if ([string]::IsNullOrWhiteSpace($plainPassword)) {
  throw "PFX password cannot be empty."
}

$bytes = [System.IO.File]::ReadAllBytes($resolvedPfxPath.Path)
$base64 = [System.Convert]::ToBase64String($bytes)

$tempBase64Path = [System.IO.Path]::GetTempFileName()
$tempPasswordPath = [System.IO.Path]::GetTempFileName()

try {
  Set-Content -Path $tempBase64Path -Value $base64 -NoNewline -Encoding ASCII
  Set-Content -Path $tempPasswordPath -Value $plainPassword -NoNewline -Encoding UTF8

  Get-Content -Raw $tempBase64Path | gh secret set WINDOWS_CERT_PFX_BASE64 --repo $repoName
  Get-Content -Raw $tempPasswordPath | gh secret set WINDOWS_CERT_PASSWORD --repo $repoName

  Write-Host "Code-signing secrets updated for repo: $repoName"
} finally {
  Remove-Item -Path $tempBase64Path -ErrorAction SilentlyContinue
  Remove-Item -Path $tempPasswordPath -ErrorAction SilentlyContinue
}
