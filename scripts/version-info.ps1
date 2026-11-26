# Reports the Windows version resource of an executable as compact JSON.

param(
  [Parameter(Mandatory = $true)]
  [string]$Path
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Path)) {
  throw "File not found: $Path"
}

$info = (Get-Item -LiteralPath $Path).VersionInfo

[pscustomobject]@{
  fileVersion = $info.FileVersion
  productVersion = $info.ProductVersion
  productName = $info.ProductName
} | ConvertTo-Json -Compress
