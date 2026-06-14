@echo off
REM ASCII-only launcher. Real work (in Chinese) is done by start.ps1.
chcp 65001 >nul
cd /d "%~dp0"
title OpenRouter Console (RUNNING - do not close this window)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
if errorlevel 1 pause
