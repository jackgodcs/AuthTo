@echo off
setlocal
set "TOSUB2_POWERSHELL=D:\Program Files\PowerShell-7.5.3-win-x64\pwsh.exe"
set "TOSUB2_NODE=D:\Program Files\nodejs\node.exe"
if not exist "%TOSUB2_POWERSHELL%" set "TOSUB2_POWERSHELL=pwsh.exe"
if not exist "%TOSUB2_NODE%" set "TOSUB2_NODE=node.exe"
"%TOSUB2_POWERSHELL%" -NoLogo -NoProfile -NonInteractive -Command "$ErrorActionPreference = 'Stop'; $secret = Read-Host '粘贴 CPAMP 管理密钥（输入内容不会显示）' -AsSecureString; $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret); try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer); [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); [Console]::Out.Write($plain) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }" | "%TOSUB2_NODE%" "%~dp0src\repair-cpamp-management-key.mjs"
if errorlevel 1 pause
exit /b %errorlevel%
