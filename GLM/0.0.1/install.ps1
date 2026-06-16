# OpenRouter 控制台 — 一键安装 (Windows / PowerShell)
# 由 install.bat 调起;也可直接右键「用 PowerShell 运行」。
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # 让 winget/下载快一点、少刷屏
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}
Set-Location -LiteralPath $PSScriptRoot

function Info($m){ Write-Host $m }
function Ok($m){   Write-Host "[OK] $m"  -ForegroundColor Green }
function Warn($m){ Write-Host "[!] $m"   -ForegroundColor Yellow }
function Err($m){  Write-Host "[X] $m"   -ForegroundColor Red }
function Have($c){ [bool](Get-Command $c -ErrorAction SilentlyContinue) }
function Refresh-Path {
  # winget 装完后,新程序的 PATH 在注册表里,本会话还是旧的 —— 立刻刷新,免得让用户重开窗口
  $m = [Environment]::GetEnvironmentVariable('Path','Machine')
  $u = [Environment]::GetEnvironmentVariable('Path','User')
  $env:Path = (@($m,$u) | Where-Object { $_ }) -join ';'
}

Write-Host "============================================================"
Write-Host "   OpenRouter 控制台 — 一键安装 (Windows)"
Write-Host "   自动: Python + 依赖 / Node 运行时 / 配置文件 / 装完自检"
Write-Host "============================================================"
Write-Host ""

$haveWinget = Have winget
if (-not $haveWinget) { Warn "本机没有 winget(应用安装程序)。缺 Python/Node 时只能手动装,会给你网址。" }

# ---------- 1. Python ----------
$PyExe = $null; $PyPre = @()
function Probe-Python {
  if (Have py)     { py -3 --version *> $null; if ($LASTEXITCODE -eq 0) { $script:PyExe='py'; $script:PyPre=@('-3'); return } }
  if (Have python) { python --version *> $null; if ($LASTEXITCODE -eq 0) { $script:PyExe='python'; $script:PyPre=@(); return } }
}
Probe-Python
if (-not $PyExe) {
  Warn "没检测到 Python 3。"
  if ($haveWinget) {
    Info "    正在用 winget 安装 Python 3.12,请稍候(较慢,别关窗口)..."
    winget install -e --id Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements
    Refresh-Path; Probe-Python
    if (-not $PyExe) { Err "Python 自动安装/识别失败。请手动装 https://www.python.org/downloads/(安装勾选 Add to PATH)后重跑本脚本。"; exit 1 }
    Ok "Python 安装完成。"
  } else {
    Err "请手动安装 Python 3(勾选 Add Python to PATH):https://www.python.org/downloads/  装完后重跑本脚本。"; exit 1
  }
}

# ---------- 2. Node.js ----------
if (-not (Have node)) {
  Warn "没检测到 Node.js。"
  if ($haveWinget) {
    Info "    正在用 winget 安装 Node.js LTS,请稍候..."
    winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    Refresh-Path
    if (-not (Have node)) { Err "Node 自动安装/识别失败。请手动装 https://nodejs.org/ 后重跑本脚本。"; exit 1 }
    Ok "Node 安装完成。"
  } else {
    Err "请手动安装 Node.js LTS:https://nodejs.org/  装完后重跑本脚本。"; exit 1
  }
}
Ok ("已就绪 → Python: " + ((& $PyExe @PyPre --version) -join ' ') + "   Node: " + (node --version))
Write-Host ""

# ---------- 3. Python 依赖 ----------
Info "[3/5] 安装 Python 依赖 (selenium / websocket-client 等)..."
& $PyExe @PyPre -m pip install --upgrade pip *> $null
$req = "selenium-e2e\requirements.txt"
& $PyExe @PyPre -m pip install -r $req
if ($LASTEXITCODE -ne 0) {
  Warn "直连 PyPI 失败,改用清华镜像重试..."
  & $PyExe @PyPre -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -r $req
}
if ($LASTEXITCODE -ne 0) { Err "Python 依赖安装失败(多半是网络)。把上面的报错截图发出来排查。"; exit 1 }
Ok "Python 依赖装好了。"
Write-Host ""

# ---------- 4. 配置文件 ----------
Info "[4/5] 准备配置文件..."
if (Test-Path "config\config.local.json") {
  Ok "config\config.local.json 已存在,保留你现有的配置(不覆盖)。"
} elseif (Test-Path "config\config.local.example.json") {
  Copy-Item "config\config.local.example.json" "config\config.local.json"
  Ok "已生成 config\config.local.json(key 还是空的,稍后在网页里填)。"
} else {
  Warn "没找到配置模板,跳过(可在网页『设置中心』直接填 key)。"
}
Write-Host ""

# ---------- 5. AdsPower ----------
Info "[5/5] 检查 AdsPower 本地接口..."
& curl.exe -s -m 5 "http://local.adspower.net:50325/status" *> $null
if ($LASTEXITCODE -eq 0) { Ok "AdsPower 在运行。" }
else { Warn "没连上 AdsPower 本地接口。请先【打开 AdsPower 客户端并登录】(没装去 https://www.adspower.com 下载,有 Win/Mac 版)。" }
Write-Host ""

# ---------- 自检:依赖真能用吗 ----------
Info "[自检] 验证关键依赖可导入..."
& $PyExe @PyPre -c "import selenium, websocket; print('selenium', selenium.__version__, '| websocket-client OK')"
if ($LASTEXITCODE -ne 0) { Err "自检失败:selenium / websocket 导入不了,依赖没装全。重跑本脚本,或把报错发出来。"; exit 1 }
Ok "自检通过,核心依赖可用。"
Write-Host ""

Write-Host "============================================================"
Ok "安装完成!接下来:"
Write-Host "   1) 双击  start.bat  启动控制台"
Write-Host "   2) 浏览器会自动打开  http://localhost:4317"
Write-Host "   3) 进「设置中心 / 部署引导」填:Firstmail key、验证码(capsolver/2captcha)key、AdsPower key"
Write-Host "   4) 确保 AdsPower 客户端开着,再到「控制台」起任务(并发建议先 5~8,别太大)"
Write-Host ""
Write-Host "   想用【混合引擎(Playwright)】?另外双击  install-hybrid.bat  安装(会下载浏览器内核,约 150MB)。"
Write-Host "   纯 Selenium 引擎现在就能用,不需要装它。"
Write-Host "============================================================"
