#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
echo "Installing Node dependencies..."
npm install
echo "Installing Playwright Chromium..."
npx playwright install chromium
echo "Done. Run ./start.sh to launch the console."
