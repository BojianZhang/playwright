#!/usr/bin/env bash
# OpenRouter — 安装【混合引擎(Playwright)】依赖 (macOS / Linux)。 用法: bash install-hybrid.sh
# 纯 Selenium 不需要这个; 只有想用「混合 / split 分流」引擎才装。
set -e
cd "$(dirname "$0")"

echo "============================================================"
echo "   OpenRouter — 安装混合引擎(Playwright)依赖"
echo "============================================================"

command -v node >/dev/null 2>&1 || { echo "[X] 没装 Node, 请先跑: bash install.sh"; exit 1; }

# 向上找到带 Playwright 的仓库根(混合引擎靠 Node 向上解析 node_modules/playwright)
d="$(pwd)"; root=""
while [ "$d" != "/" ] && [ -n "$d" ]; do
  if [ -f "$d/package.json" ] && grep -Eq '"@playwright/test"|"playwright"' "$d/package.json"; then root="$d"; break; fi
  d="$(dirname "$d")"
done

if [ -z "$root" ]; then
  echo "[!] 没找到带 Playwright 的 package.json。"
  echo "    混合引擎需要【完整仓库】(你可能只拿了 Openrouter/0.0.1 子目录)。纯 Selenium 不受影响, 可正常使用。"
  exit 0
fi
echo "找到仓库根: $root"

echo "[1/2] 安装 Node 依赖 (npm install)..."
( cd "$root" && npm install )
echo "[2/2] 下载 Playwright Chromium 内核 (约 150MB, 较慢)..."
( cd "$root" && npx playwright install chromium )

echo "[OK] 混合引擎(Playwright)装好了! 到控制台『引擎』里选「混合」或「分流」即可。"
