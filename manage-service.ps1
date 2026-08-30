param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("start", "stop")]
  [string]$Action
)

$ErrorActionPreference = "Stop"
$appDir = $PSScriptRoot
$dataDir = Join-Path $env:LOCALAPPDATA "toSub2"
$logDir = Join-Path $dataDir "logs"
$pidFile = Join-Path $dataDir "tosub2.pid"
$outputRoot = Join-Path $dataDir "chatgpt-onboarding-console"
$outLog = Join-Path $logDir "tosub2.log"
$errLog = Join-Path $logDir "tosub2-error.log"
$bundledPythonExe = Join-Path $appDir "python\python.exe"
$powerShell7 = "D:\Program Files\PowerShell-7.5.3-win-x64\pwsh.exe"

function Get-ManagedProcess {
  if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
  $pidText = (Get-Content -LiteralPath $pidFile -Raw).Trim()
  $processId = 0
  if (-not [int]::TryParse($pidText, [ref]$processId)) {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    return $null
  }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
  if ($null -eq $process -or $process.CommandLine -notlike "*console-server.mjs*") {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    return $null
  }
  return $process
}

function Get-NodeExe {
  $candidates = @("D:\Program Files\nodejs\node.exe")
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCommand) { $candidates += $nodeCommand.Source }
  return $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}

function Get-PythonExe {
  if (Test-Path -LiteralPath $bundledPythonExe) { return $bundledPythonExe }
  $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
  if ($pythonCommand -and (Test-Path -LiteralPath $pythonCommand.Source)) { return $pythonCommand.Source }
  $pyCommand = Get-Command py -ErrorAction SilentlyContinue
  if ($pyCommand -and (Test-Path -LiteralPath $pyCommand.Source)) { return $pyCommand.Source }
  return $null
}

if ($Action -eq "start") {
  $existing = Get-ManagedProcess
  if ($existing) {
    Write-Host "toSub2 is already running (PID $($existing.ProcessId))."
    exit 0
  }

  $nodeExe = Get-NodeExe
  $pythonExe = Get-PythonExe
  if (-not $nodeExe) { throw "Node.js 20 or later was not found." }
  if (-not $pythonExe) { throw "Python 3.9 or later was not found. Install Python or place it in $bundledPythonExe." }

  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  $env:TOSUB2_PYTHON = $pythonExe
  $env:ONBOARDING_OUTPUT_ROOT = $outputRoot
  $env:TOSUB2_POWERSHELL = if (Test-Path -LiteralPath $powerShell7) { $powerShell7 } else { "pwsh.exe" }
  $env:CHATGPT_DEFAULT_PROXY_URL = "socks5h://127.0.0.1:10808"
  $process = Start-Process -FilePath $nodeExe `
    -ArgumentList @("src/console-server.mjs", "--host", "127.0.0.1", "--port", "4399") `
    -WorkingDirectory $appDir `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog `
    -WindowStyle Hidden `
    -PassThru

  Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ascii
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    $process.Refresh()
    if ($process.HasExited) { break }
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:4399/api/bootstrap" -TimeoutSec 1
      if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
    Start-Sleep -Milliseconds 250
  }
  if (-not $ready) {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    $lastError = if (Test-Path -LiteralPath $errLog) { (Get-Content -LiteralPath $errLog -Tail 8) -join [Environment]::NewLine } else { "No error log was written." }
    throw "toSub2 did not become ready during startup.`n$lastError"
  }
  $listeningProcess = Get-NetTCPConnection -LocalPort 4399 -State Listen -ErrorAction Stop | Select-Object -First 1
  Set-Content -LiteralPath $pidFile -Value $listeningProcess.OwningProcess -Encoding ascii

  Write-Host "toSub2 started."
  Write-Host "Open: http://127.0.0.1:4399"
  Write-Host "Logs: $logDir"
  exit 0
}

$existing = Get-ManagedProcess
if (-not $existing) {
  Write-Host "toSub2 is not running."
  exit 0
}

Stop-Process -Id $existing.ProcessId -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
if (Get-Process -Id $existing.ProcessId -ErrorAction SilentlyContinue) {
  Stop-Process -Id $existing.ProcessId -Force -ErrorAction SilentlyContinue
}
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
Write-Host "toSub2 stopped."
