# GLM 自动化（z.ai / GLM Coding Plan）

纯 Selenium + AdsPower 流水线,自动化 **chat.z.ai** 账号全生命周期:
**注册(滑块拼图验证 + 邮箱链接验证 + 完成注册) → 登录 → 创建 API Key → 订阅 GLM Coding Plan(选套餐 + 信用卡支付)**,
带逐阶段断点续跑、真金白银防重复扣款、AdsPower 指纹环境隔离、React 控制台。

架构参照同仓 `Openrouter/0.0.1`(选择器/反检测/Stripe 相关已替换为 z.ai 的滑块 + 订阅支付)。

---

## 与 Openrouter 的关键差异

| 维度 | Openrouter | GLM(z.ai) |
|---|---|---|
| 认证 | Clerk | Open WebUI(localStorage token,非 `window.Clerk`) |
| 人机验证 | Turnstile / hCaptcha(2captcha token) | **滑块拼图**(2Captcha Coordinates 取缺口坐标 + 本地可信 CDP 拖拽) |
| 计费 | Stripe 充值积分 | **订阅 GLM Coding Plan**(Lite/Pro/Max × 月/季/年 + 信用卡表单) |
| 邮箱验证 | firstmail.ltd(Clerk 链接) | firstmail.ltd(z.ai `verify_email` 链接,同一 REST API) |

阶段状态机:`env → auth(register|login) → apikey(可开关) → subscribe(可开关·真金白银)`。
**创建 API Key 独立于订阅**——可只取 key 不订阅,也可订阅前先取 key(无强制顺序耦合)。

---

## 目录

```
selenium-e2e/   纯 Selenium 流水线(入口 run.py → pipeline.py → steps/services/common)
  steps/        steps_auth(注册/登录+滑块) · steps_apikey(创建并抓Key) · steps_subscribe(选套餐+支付)
  services/     slider(2Captcha滑块) · firstmail(邮箱验证) · adspower_env · cdp_raw(可信CDP输入/拖拽)
  common/       page/driver/adspower/ledger/config/base/attribution …(基础设施,大部分原样复用)
web/            React+Vite 控制台(server.js + engine-runner.js + 各 *-store + src/)
billing/        卡池 / 随机地址 / 账本(原样复用)
config/         config.json(非密) · config.local.json(密钥,gitignore)
data/           运行数据(账号/卡池/结果/预设,gitignore)
```

---

## 前置

- **AdsPower** 客户端开着 + Local API(默认 `http://127.0.0.1:50325`)。
- **firstmail** 账号(账号文件每行 `email:邮箱密码`)+ firstmail **X-API-KEY**(读验证邮件)。
- **2Captcha** key(解滑块缺口坐标)。
- **代理池**(每个 AdsPower 环境配一个出口 IP)。
- Python 3.10+、Node 18+。

## 安装

```bash
python -m pip install -r selenium-e2e/requirements.txt   # selenium + websocket-client
cd web && npm install                                     # 控制台依赖(React/Vite/TS)
```

## 配置密钥

复制 `config/config.local.example.json` → `config/config.local.json`,填:

```json
{
  "captcha": { "provider": "twocaptcha", "apiKey": "你的 2captcha key" },
  "mailbox": { "apiBaseUrl": "https://firstmail.ltd", "apiKey": "firstmail X-API-KEY" },
  "adspower": { "apiBase": "http://127.0.0.1:50325", "apiKey": "" }
}
```

套餐价格矩阵在 `config/config.json` 的 `subscribe.prices`(占位值,真机首跑按 z.ai 实际定价校正)。

---

## 跑法 A:命令行

账号文件 `accts.txt`(每行 `email:邮箱密码`),代理文件 `proxies.txt`(每行 `host:port:user:pass`)。

```bash
# 只注册 + 创建 API Key(不订阅)
python selenium-e2e/run.py --accounts accts.txt --proxies proxies.txt --do-apikey

# 注册 + 创建Key + 订阅(dry-run:走到 Confirm 不真扣,零成本验证全流程)
python selenium-e2e/run.py --accounts accts.txt --proxies proxies.txt \
  --do-apikey --do-subscribe --plan max --cycle monthly

# 真实订阅(★真扣款):加 --real-charge,并用 --charge-count 限整批真扣次数
python selenium-e2e/run.py --accounts accts.txt --proxies proxies.txt \
  --do-apikey --do-subscribe --plan max --cycle monthly --real-charge --charge-count 1
```

常用开关:`--no-apikey` 跳过取key · `--plan {lite|pro|max}` · `--cycle {monthly|quarterly|yearly}` ·
`--real-charge`(真扣)· `--card-charge-gate`(卡容量账本,真扣时自动随 `--real-charge` 开)· `--charge-count N`(整批真扣帽)·
`--limit-by-capacity` · `--unified-pw <密码>`(z.ai 账号密码,不设=用邮箱密码)· `--concurrency N` · `--no-resume`(强制整组重跑)。

结果落 `selenium-e2e/state/results.jsonl`;断点续跑用 `selenium-e2e/state/sel_account_progress.json`。

## 跑法 B:Web 控制台

```bash
node web/server.js          # 默认 http://localhost:4317(GLM_WEB_PORT 可改)
```

控制台第 2 步「引擎 & 全局」里选 selenium 引擎配置:创建Key / 订阅 / 套餐 / 周期 / 真实支付 / 滑块校准等。
第 1 步贴账号 + 代理,点运行;实时进度 + 结果 + 创建的 API Key 在结果/详情页。

> 安全:对外暴露务必设 `GLM_AUTH_TOKEN=随机串`(否则任何人可拉取你的账号/Key)。

---

## 防重复扣款(订阅=真金白银)

- 两个独立「已订阅」信号:checkpoint `stages.subscribe==ok` + results 还原的 `subscribed` → 任一为真即跳过订阅。
- 真扣前 `reserve_charge`(卡容量账本原子预留)→ 成功 `commit_charge` / 失败 `release_charge`;`--charge-count` 整批帽;崩溃遗留预留启动时 `reap_stale_inflight` 回收。
- 默认 **dry-run**(不传 `--real-charge`)= 走到 Confirm 不真点。

---

## 验证 / 测试

```bash
python selenium-e2e/test_pipeline_logic.py     # 离线回归:续跑/订阅去重/归因/容量账本/滑块轨迹(34 项)
cd web && node --test                           # 后端纯函数:成功判定/解析/映射(14 项)
cd web && node node_modules/typescript/lib/tsc.js --noEmit   # 前端类型
cd web && node node_modules/vite/bin/vite.js build           # 前端构建 → public/
python selenium-e2e/services/adspower_env.py --selftest --proxy host:port:user:pass   # AdsPower 真开浏览器自测
```

**真机冒烟(先 0 成本,再 1 笔真扣)**:
1. 1 个号 `--do-apikey --do-subscribe --plan pro --cycle monthly`(不加 `--real-charge`)→ 验证滑块/邮箱链接/完成注册/登录滑块/抓Key/支付表单填到 Confirm 停手。
2. 通过后加 `--real-charge --charge-count 1` → 确认「Payment Success」、结果行 `subscribe:success`+`subscribed:金额`;**再续跑同号应跳过订阅**(不重复扣款)。

---

## 真机首跑需校准的点(见 plan 风险段)

- **滑块**:看日志里 `[slider] 实测 …` 与 `拖拽距离=…`,按需用环境变量 `SLIDER_SCALE` / `SLIDER_OFFSET` / `SLIDER_ATTEMPTS`(控制台引擎配置也可设)校准缺口距离。若 2Captcha 需要拼图块图/距离从块左缘量,见 `services/slider.py` 注释。
- **支付表单是否 Stripe 跨 iframe**:`steps_subscribe` 默认用跨 iframe 兜底填卡;若实测是一级 iframe 的 OOPIF,见 `GLM_PAY_CDP` 预留位。
- **z.ai 套餐真实价格** 填进 `config.json subscribe.prices`;**API Key 明文格式** 若钩子抓不到,见 `steps_apikey` 的剪贴板/DOM 兜底。
