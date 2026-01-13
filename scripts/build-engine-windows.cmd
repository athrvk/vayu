@echo off
REM Wrapper to run PowerShell script from cmd.exe
SETLOCAL ENABLEDELAYEDEXPANSION

SET SCRIPT_DIR=%~dp0
SET PS1=%SCRIPT_DIR%build-engine-windows.ps1

IF NOT EXIST "%PS1%" (
  echo PowerShell script not found: %PS1%
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
IF %ERRORLEVEL% NEQ 0 exit /b %ERRORLEVEL%
