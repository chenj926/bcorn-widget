@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -File "%~dp0Sign-bcorn.ps1"
echo.
echo If Windows blocks this script, read WINDOWS_LOCAL_SIGNING.md. Do not bypass security policy.
pause
