@echo off
REM ASCII-only launcher. Real work (in Chinese) is done by install-hybrid.ps1.
REM Optional: only needed for the hybrid / split (Playwright) engine. Pure Selenium does NOT need this.
chcp 65001 >nul
cd /d "%~dp0"
title OpenRouter Console - Hybrid (Playwright) Installer
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-hybrid.ps1"
echo.
pause
