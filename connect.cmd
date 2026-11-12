@echo off
setlocal
chcp 65001 >nul
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 is required. Ask the provider to configure it first.
  pause
  exit /b 1
)
node.exe "%~dp0integration\harness-integration\official-plugin\connect.mjs" --portable-root "%~dp0." %*
set "csyExit=%errorlevel%"
pause
exit /b %csyExit%
