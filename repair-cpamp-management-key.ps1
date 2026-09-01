$ErrorActionPreference = "Stop"
$appDir = $PSScriptRoot
$nodeExe = "D:\Program Files\nodejs\node.exe"

if (-not (Test-Path -LiteralPath $nodeExe)) {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCommand) { $nodeExe = $nodeCommand.Source }
}
if (-not (Test-Path -LiteralPath $nodeExe)) {
  throw "Node.js was not found."
}

$repairScript = Join-Path $appDir "src\repair-cpamp-management-key.mjs"
if (-not (Test-Path -LiteralPath $repairScript)) {
  throw "The CPAMP key repair program is missing."
}

Write-Host "Paste the CPAMP management key below. The input will not be displayed."
$secureKey = Read-Host "CPAMP management key" -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)

try {
  $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
  $plainKey | & $nodeExe $repairScript
  $exitCode = $LASTEXITCODE
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  $plainKey = $null
}

exit $exitCode
