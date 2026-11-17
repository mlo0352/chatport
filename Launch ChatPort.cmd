@echo off
if exist "%LOCALAPPDATA%\ChatPort\chatport.exe" (
  start "" "%LOCALAPPDATA%\ChatPort\chatport.exe"
  exit /b
)
if exist "%~dp0ChatPort-Setup.exe" (
  start "" "%~dp0ChatPort-Setup.exe"
  exit /b
)
echo Build ChatPort with npm install and npm run dist.
pause
