#!/usr/bin/env bash
# OpenRouter 控制台 — 一键启动 (macOS / Linux)。 用法: bash start.sh
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "[X] 未装 Node, 请先跑: bash install.sh"; exit 1; }

echo "控制台启动中... 浏览器将打开 http://localhost:4317  (按 Ctrl+C 停止服务)"
# 延时开浏览器(等服务器起来)
( sleep 4
  if command -v open >/dev/null 2>&1; then open http://localhost:4317
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open http://localhost:4317
  fi ) &

cd web && node server.js
