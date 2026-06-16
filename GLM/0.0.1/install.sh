#!/usr/bin/env bash
# OpenRouter 自动化控制台 — 一键安装 (macOS / Linux)
# 用法:  bash install.sh
set -e
cd "$(dirname "$0")"

echo "============================================================"
echo "   OpenRouter 自动化控制台   一键安装 (macOS / Linux)"
echo "============================================================"
OS="$(uname -s)"

# ---- macOS: 没 Homebrew 就自动装(用来自动装 Python/Node)----
if [ "$OS" = "Darwin" ] && ! command -v brew >/dev/null 2>&1; then
  echo "[*] 未检测到 Homebrew, 自动安装中... (可能要你输入 Mac 登录密码, 首次会装 Xcode 命令行工具, 较慢)"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # 让【当前会话】立刻能用 brew(Apple 芯片在 /opt/homebrew, Intel 在 /usr/local)
  [ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
  [ -x /usr/local/bin/brew ]   && eval "$(/usr/local/bin/brew shellenv)"
fi

# ---- Python3 ----
if ! command -v python3 >/dev/null 2>&1; then
  echo "[缺] 未检测到 Python3。"
  if command -v brew >/dev/null 2>&1; then brew install python
  elif command -v apt-get >/dev/null 2>&1; then sudo apt-get update && sudo apt-get install -y python3 python3-pip
  elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y python3 python3-pip
  else echo "    请手动装 Python3 后重跑: https://www.python.org/downloads/"; exit 1; fi
fi

# ---- Node.js ----
if ! command -v node >/dev/null 2>&1; then
  echo "[缺] 未检测到 Node.js。"
  if command -v brew >/dev/null 2>&1; then brew install node
  elif command -v apt-get >/dev/null 2>&1; then sudo apt-get install -y nodejs npm
  elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y nodejs
  else echo "    请手动装 Node.js LTS 后重跑: https://nodejs.org/"; exit 1; fi
fi

echo "[OK] python3: $(python3 --version)   node: $(node --version)"

# ---- Python 依赖(兼容新版 Homebrew Python 的 PEP668 限制 + 国内镜像兜底)----
echo "[*] 安装 Python 依赖 (selenium 等)..."
PIP="python3 -m pip"
$PIP install --upgrade pip >/dev/null 2>&1 || true
REQ="selenium-e2e/requirements.txt"
$PIP install -r "$REQ" \
  || $PIP install --break-system-packages -r "$REQ" \
  || $PIP install --break-system-packages -i https://pypi.tuna.tsinghua.edu.cn/simple -r "$REQ"
echo "[OK] Python 依赖装好了。"

# ---- 配置文件 ----
if [ ! -f config/config.local.json ] && [ -f config/config.local.example.json ]; then
  cp config/config.local.example.json config/config.local.json
  echo "[OK] 已生成 config/config.local.json (key 待填)"
else
  echo "[OK] config/config.local.json 已存在或无模板, 跳过(不覆盖你的配置)"
fi

# ---- AdsPower 检查 ----
if curl -s -m 5 http://local.adspower.net:50325/status >/dev/null 2>&1; then
  echo "[OK] AdsPower 在运行"
else
  echo "[!] 没连上 AdsPower 本地接口, 请先打开 AdsPower 客户端并登录 (https://www.adspower.com, 有 Mac 版)"
  if [ "$OS" = "Darwin" ]; then echo "    (若用 Fix B 真键鼠兜底: 系统设置 > 隐私与安全性 > 辅助功能, 给『终端』授权; 默认 Fix C 不需要)"; fi
fi

# ---- 自检: 依赖真能用吗 ----
echo "[自检] 验证关键依赖可导入..."
python3 -c "import selenium, websocket; print('selenium', selenium.__version__, '| websocket-client OK')" \
  || { echo "[X] 自检失败: selenium / websocket 导入不了, 依赖没装全。重跑本脚本或把报错发出来。"; exit 1; }
echo "[OK] 自检通过, 核心依赖可用。"

echo "============================================================"
echo " 安装完成! 运行:  bash start.sh"
echo " 然后浏览器打开 http://localhost:4317 → 设置中心填 key"
echo ""
echo " 想用【混合引擎(Playwright)】? 另外运行:  bash install-hybrid.sh"
echo " (会下载浏览器内核, 约 150MB; 纯 Selenium 不需要它)"
echo "============================================================"
