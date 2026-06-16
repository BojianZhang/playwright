@echo off
REM ASCII-only launcher. Real work (in Chinese) is done by install.ps1.
chcp 65001 >nul
cd /d "%~dp0"
title OpenRouter Console - Installer
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
pause
