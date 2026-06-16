# OpenRouter 控制台 — 一键启动 (Windows / PowerShell)。由 start.bat 调起。
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}
Set-Location -LiteralPath $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "[X] 没检测到 Node.js,请先双击 install.bat 安装。" -ForegroundColor Red
  Read-Host "按回车退出" | Out-Null
  exit 1
}

Write-Host "============================================================"
Write-Host "   OpenRouter 控制台 启动中..."
Write-Host "   - 浏览器会自动打开  http://localhost:4317  (没弹就手动打开这个网址)"
Write-Host "   - 这个窗口就是服务器,【别关它】;要停服务就关掉它(或按 Ctrl+C)"
Write-Host "============================================================"
Write-Host ""

# 延时 5 秒再开浏览器(等服务器起来);用独立隐藏进程,不挡住下面的 server
Start-Process -WindowStyle Hidden powershell -ArgumentList @(
  '-NoProfile','-Command','Start-Sleep -Seconds 5; Start-Process "http://localhost:4317"'
) | Out-Null

Set-Location -LiteralPath (Join-Path $PSScriptRoot "web")
node server.js

Write-Host ""
Write-Host "[服务器已退出] 关闭窗口即可。"
Read-Host "按回车退出" | Out-Null
