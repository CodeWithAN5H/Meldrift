# Authenticode signing for the Meldrift application and NSIS installer.
#
# The certificate is supplied through environment variables, never through a
# file in the repository. Values are never printed.
#
# Usage (CI or local):
#   $env:SIGN_PFX_PATH = "C:\certs\meldrift.pfx"
#   $env:SIGN_PFX_PASSWORD = "..."
#   ./scripts/sign.ps1                                  # newest NSIS installer
#   ./scripts/sign.ps1 -Path path\to\meldrift.exe
#   ./scripts/sign.ps1 -Path ... -Require               # fail if no certificate
#
# A missing certificate is reported as BLOCKED (exit 0) unless signing is
# required, in which case the script fails. It never produces or invents a
# signature.

param(
  [string[]]$Path,
  [switch]$Require
)

$ErrorActionPreference = "Stop"

$pfx = $env:SIGN_PFX_PATH
$password = $env:SIGN_PFX_PASSWORD
$required = $Require -or ($env:MELDRIFT_REQUIRE_SIGNING -eq "1")

if ([string]::IsNullOrWhiteSpace($pfx) -or [string]::IsNullOrWhiteSpace($password)) {
  if ($required) {
    throw "Signing is required but SIGN_PFX_PATH / SIGN_PFX_PASSWORD are not set."
  }
  Write-Output "BLOCKED: no signing certificate configured; refusing to claim a signature. The build stays unsigned."
  exit 0
}

if (-not (Test-Path -LiteralPath $pfx)) {
  throw "Signing certificate not found at SIGN_PFX_PATH."
}

function Find-SignTool {
  $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  $roots = @(
    "${env:ProgramFiles(x86)}\Windows Kits\10\bin",
    "${env:ProgramFiles}\Windows Kits\10\bin"
  )
  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $tool = Get-ChildItem -LiteralPath $root -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match '\\x64\\' } |
      Sort-Object FullName -Descending |
      Select-Object -First 1
    if ($tool) { return $tool.FullName }
  }
  throw "signtool.exe was not found. Install the Windows SDK signing tools."
}

if (-not $Path -or $Path.Count -eq 0) {
  $bundle = Join-Path (Get-Location) "src-tauri\target\release\bundle\nsis"
  if (-not (Test-Path -LiteralPath $bundle)) {
    throw "NSIS bundle directory not found: $bundle. Run 'bun run tauri bundle' first."
  }
  $installer = Get-ChildItem -LiteralPath $bundle -Filter *.exe |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $installer) { throw "No installer executable found in $bundle." }
  $Path = @($installer.FullName)
}

$signtool = Find-SignTool

foreach ($target in $Path) {
  if (-not (Test-Path -LiteralPath $target)) {
    throw "Cannot sign a missing file: $target"
  }

  & $signtool sign /fd SHA256 /td SHA256 /tr "http://timestamp.digicert.com" /f $pfx /p $password $target | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "signtool sign failed with exit code $LASTEXITCODE for $target"
  }

  & $signtool verify /pa /v $target | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "signtool verify failed with exit code $LASTEXITCODE for $target"
  }

  $signature = Get-AuthenticodeSignature -LiteralPath $target
  if ($signature.Status -ne "Valid") {
    throw "Signature status for $target is $($signature.Status), not Valid."
  }

  Write-Output "SIGNED=$target STATUS=Valid SIGNER=$($signature.SignerCertificate.Subject)"
}
