@echo off
REM Dreamina 0.0.4 installer: deps + Chromium
cd /d "%~dp0"
echo Installing Node dependencies...
call npm install
echo Installing Playwright Chromium...
call npx playwright install chromium
echo Done. Run start.bat to launch the console.
