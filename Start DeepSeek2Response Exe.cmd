@echo off
setlocal
cd /d "%~dp0"

if not exist ".env" if not exist "dist\.env" (
  echo Missing .env. Copy .env.example to .env and set DEEPSEEK_API_KEY.
  pause
  exit /b 1
)

if not exist "dist\deepseek2response.exe" (
  echo Missing dist\deepseek2response.exe. Run npm run build:exe first.
  pause
  exit /b 1
)

dist\deepseek2response.exe
pause
