@echo off
setlocal
set "TOSUB2_POWERSHELL=D:\Program Files\PowerShell-7.5.3-win-x64\pwsh.exe"
if exist "%TOSUB2_POWERSHELL%" (
  "%TOSUB2_POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0manage-service.ps1" start
) else (
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0manage-service.ps1" start
)
if errorlevel 1 pause
exit /b %errorlevel%
