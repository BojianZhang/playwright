# Openrouter 控制台 — 服务器部署指南（Ubuntu / CentOS）

支持**无头**与**有头**两种浏览器模式。服务器无物理显示器时,"有头"通过 **Xvfb 虚拟显示**实现。

---

## 1. 安装依赖

### Node.js 18+（建议 20+）
```bash
# Ubuntu
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### 项目依赖 + Playwright 浏览器与系统库
```bash
cd /path/to/playwright          # 仓库根目录
npm install
npx playwright install chromium        # 内置 Chromium（兜底）
npx playwright install-deps chromium   # 系统依赖(libnss3 等)
```

### （推荐）真实 Chrome —— Turnstile 通过率更高
```bash
# Ubuntu
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt install -y ./google-chrome-stable_current_amd64.deb
# CentOS
sudo yum install -y https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm
```
> 没装 Chrome 也能跑:代码会**自动回退内置 Chromium**。也可在 `config.json` 把 `browser.channel` 设为 `""` 强制用 Chromium。

### 有头模式所需:Xvfb（虚拟显示）
```bash
# Ubuntu
sudo apt install -y xvfb x11-utils      # x11-utils 提供 xdpyinfo(窗口平铺探测分辨率)
# CentOS
sudo yum install -y xorg-x11-server-Xvfb xorg-x11-utils
```

---

## 2. 放置密钥（不在 Git 里,需手动拷贝）
`Openrouter/0.0.1/config.local.json`：
```json
{
  "captcha": { "provider": "2captcha", "apiKey": "你的2captcha_key" },
  "mailbox": { "apiKey": "你的firstmail_key" }
}
```

---

## 3. 启动

### 仅无头(最省事,生产推荐)
```bash
node Openrouter/0.0.1/web/server.js
# 表单里【不要勾】有头模式
```

### 同时支持有头(Xvfb)
```bash
# 方式 A: xvfb-run 一键(分辨率决定窗口平铺范围)
xvfb-run -s "-screen 0 1920x1080x24" node Openrouter/0.0.1/web/server.js

# 方式 B: 手动起 Xvfb
Xvfb :99 -screen 0 2560x1440x24 &
export DISPLAY=:99
node Openrouter/0.0.1/web/server.js
```
> 有头时:表单勾"有头模式",窗口会在 Xvfb 里按并发数平铺(分辨率由 Xvfb 的 `-screen` 决定,代码用 `xdpyinfo` 自动探测)。无 DISPLAY 时有头会**自动降级无头**,不会崩。

---

## 4. 远程访问 + 安全

- 默认监听 `0.0.0.0`,别的电脑用 `http://<服务器IP>:4317` 访问。
- 开放防火墙:
  ```bash
  sudo ufw allow 4317/tcp          # Ubuntu
  sudo firewall-cmd --add-port=4317/tcp --permanent && sudo firewall-cmd --reload  # CentOS
  ```
- **强烈建议加鉴权**(表单含卡号等敏感信息):
  ```bash
  export OPENROUTER_WEB_USER=admin
  export OPENROUTER_WEB_PASS=一个强密码
  ```
- 或只绑本机 + SSH 隧道(最安全):
  ```bash
  export OPENROUTER_WEB_HOST=127.0.0.1
  # 本地: ssh -L 4317:localhost:4317 user@服务器
  ```
- 自定义端口:`export OPENROUTER_WEB_PORT=8080`

---

## 5. 进程常驻(pm2 示例)
```bash
npm i -g pm2
# 无头
pm2 start "node Openrouter/0.0.1/web/server.js" --name openrouter-console
# 有头(Xvfb)
pm2 start --name openrouter-console -- bash -c 'xvfb-run -s "-screen 0 1920x1080x24" node Openrouter/0.0.1/web/server.js'
pm2 save && pm2 startup
```

---

## 6. 资源与注意
- 每账号 ≈ 一个 Chrome(~300–500MB)。并发 N → 准备 N×0.5GB 内存 + 多核。
- 无头 + 机房 IP 下 Turnstile 更易被挑战 → **务必走住宅代理**,上线前小批量测通过率。
- 环境变量速查:`OPENROUTER_WEB_PORT` / `OPENROUTER_WEB_HOST` / `OPENROUTER_WEB_USER` / `OPENROUTER_WEB_PASS` / `OPENROUTER_CAPTCHA_KEY` / `OPENROUTER_FIRSTMAIL_KEY`。
