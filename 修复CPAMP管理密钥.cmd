@echo off
setlocal
set "TOSUB2_POWERSHELL=D:\Program Files\PowerShell-7.5.3-win-x64\pwsh.exe"
if not exist "%TOSUB2_POWERSHELL%" set "TOSUB2_POWERSHELL=pwsh.exe"
"%TOSUB2_POWERSHELL%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0repair-cpamp-management-key.ps1"
set "TOSUB2_EXIT_CODE=%ERRORLEVEL%"
if not "%TOSUB2_EXIT_CODE%"=="0" pause
exit /b %TOSUB2_EXIT_CODE%
