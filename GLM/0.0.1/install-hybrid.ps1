# OpenRouter — 安装【混合引擎(Playwright)】依赖 (Windows / PowerShell)。由 install-hybrid.bat 调起。
# 纯 Selenium 不需要这个;只有想用「混合 / split 分流」引擎才装。
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}
Set-Location -LiteralPath $PSScriptRoot

function Info($m){ Write-Host $m }
function Ok($m){   Write-Host "[OK] $m" -ForegroundColor Green }
function Warn($m){ Write-Host "[!] $m"  -ForegroundColor Yellow }
function Err($m){  Write-Host "[X] $m"  -ForegroundColor Red }

Write-Host "============================================================"
Write-Host "   OpenRouter — 安装混合引擎(Playwright)依赖"
Write-Host "============================================================"
Write-Host ""

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Err "没检测到 Node.js,请先双击 install.bat 装好基础环境。"; exit 1
}

# 向上找到带 Playwright 的仓库根(混合引擎靠 Node 向上解析 node_modules/playwright)
function Find-Root {
  $d = Get-Item -LiteralPath $PSScriptRoot
  while ($d) {
    $pj = Join-Path $d.FullName 'package.json'
    if (Test-Path $pj) {
      try {
        $j = Get-Content -LiteralPath $pj -Raw | ConvertFrom-Json
        $dd = $j.devDependencies; $de = $j.dependencies
        if (($dd -and $dd.'@playwright/test') -or ($de -and ($de.'@playwright/test' -or $de.playwright))) {
          return $d.FullName
        }
      } catch {}
    }
    $d = $d.Parent
  }
  return $null
}

$root = Find-Root
if (-not $root) {
  Warn "没找到带 Playwright 的 package.json。"
  Warn "混合引擎需要【完整仓库】(你可能只拿了 Openrouter/0.0.1 子目录)。纯 Selenium 不受影响,可正常使用。"
  exit 0
}
Info "找到仓库根: $root"
Write-Host ""

Info "[1/2] 安装 Node 依赖 (npm install)..."
Push-Location $root
try {
  npm install
  if ($LASTEXITCODE -ne 0) { Err "npm install 失败(多半是网络)。重试一次或换 npm 镜像。"; exit 1 }
  Write-Host ""
  Info "[2/2] 下载 Playwright Chromium 内核(约 150MB,较慢,别关窗口)..."
  npx playwright install chromium
  if ($LASTEXITCODE -ne 0) { Err "Playwright 内核下载失败(网络?)。可重试: npx playwright install chromium"; exit 1 }
} finally {
  Pop-Location
}
Write-Host ""
Ok "混合引擎(Playwright)装好了!到控制台『引擎』里选「混合」或「分流」即可。"
