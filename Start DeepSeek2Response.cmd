@echo off
setlocal
cd /d "%~dp0"

if not exist ".env" (
  echo Missing .env. Copy .env.example to .env and set DEEPSEEK_API_KEY.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found in PATH.
  echo Install Node.js 20+ or package this project with a bundled runtime.
  pause
  exit /b 1
)

node src/server.js
pause
