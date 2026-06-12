# OpenRouter 自动化流水线（Selenium / Playwright+Selenium 混合）

> 引擎②:在三引擎架构中的定位见 [../ARCHITECTURE.md](../ARCHITECTURE.md)。✅ Fix C 原生CDP绑卡 + 混合编排(子进程拉引擎① `../playwright/hybrid-pw-stage.js`) + 纯Selenium全流程 + 充值。

接管 AdsPower 指纹浏览器，批量做 OpenRouter 账号的 **注册 / 登录 / 取 API Key / 绑账单地址 / 加卡**。
**每账号新建一个干净 AdsPower 环境，跑完即删** —— 保证账号状态干净、互不串味。

提供两套方案：

| 方案 | 谁干啥 | 入口 |
|---|---|---|
| **纯 Selenium**（零 Playwright） | Selenium 全程：注册→取Key→加卡 | `run.py` |
| **Playwright+Selenium 混合**（推荐，最稳） | Playwright 做注册/取Key/绑地址 → 关浏览器 → Selenium 重开同环境加卡 | `hybrid_run.py` / `hyb_loop.py` |

---

## 1. 准备

### 配置（密钥，不入库）
`../config/config.local.json`（gitignore）里要有：
```json
{
  "captcha": { "provider": "2captcha", "apiKey": "你的2captcha key" },
  "mailbox": { "apiKey": "你的Firstmail key", "apiBaseUrl": "https://firstmail.ltd" }
}
```

### 账号文件（每行 `邮箱:邮箱密码`）
`accounts.xxx.txt`（gitignore）。**第二列是邮箱密码**（Firstmail 读注册验证链接/验证码用），**不是 OpenRouter 密码**。
OpenRouter 登录密码由 `--op-pw` 统一指定（注册时设、登录时用）。
```
alice@maildomain.com:邮箱密码A
bob@maildomain.com:邮箱密码B
```

### 代理池（每行一个，给新环境配 IP）
`proxies.local.txt`（gitignore）。**只放 socks5**（实测 http 那批容易死 → AdsPower 报 Check Proxy Fail）。
```
socks5://user:pass@host:port
```
可从现有 AdsPower 环境复用住宅代理（`user/list` 的 `user_proxy_config`）。

### 卡池
`../data/card-pool.json`（gitignore）。一卡可绑多号（实测 ~10），`maxUses` 控制上限。
`load_card(email)` 把账号摊匀到各卡上，持久化到 `state/card-assign.json`。

---

## 2. 跑

### 混合方案（推荐）
```bash
# 单跑/串行
python hybrid_run.py --accounts accounts.hybrid.txt --proxies proxies.local.txt --op-pw '统一密码'

# 并发 + 自重试到全绑(Stripe Radar 加卡是抽签,多轮换IP补齐)
HYB_CONCURRENCY=3 python hyb_loop.py        # 跑 accounts.batch19.txt
# 或直接并发单轮：
python hybrid_run.py --accounts a.txt --proxies proxies.local.txt --op-pw 'pw' --concurrency 3
```

### 纯 Selenium
```bash
python run.py --accounts accounts.local.txt --proxies proxies.local.txt --do-key --do-card --unified-pw 'pw'
```

### 常用参数（hybrid_run.py）
- `--concurrency N`：同时跑几个号（默认1）。AdsPower 本地 API 已全局限频 ~1req/s，并发安全。
- `--proxy-offset K`：代理起始下标偏移（每轮重试换 IP）。
- `--no-delete-env`：跑完不删环境（调试用）。
- `--gap S`：账号间隔秒（串行时）。

### 窗口平铺（并发时自动）
并发跑时，N 个浏览器窗口**自动平铺成网格**：列数=⌈√N⌉，每个窗口尺寸=屏幕÷网格（并发越多窗口越小，正好铺满屏，方便同时盯）。
PW 阶段经 CDP `Browser.setWindowBounds` 摆窗，Selenium 阶段经 `set_window_rect`。屏幕分辨率自动取（Windows），或用环境变量 `SCREEN_W`/`SCREEN_H` 覆盖。

---

## 3. 加卡卡顿＝切代理IP同会话重试（不重建环境/不重登）

**核心优化**：加卡撞 Stripe Radar「Saving」卡顿（server-error）或卡表单超时（unknown）时，**不删环境、不重新登录**，而是对**同一个已登录环境切换代理IP**（`/api/v1/user/update` 改代理 → 重启浏览器 → 同会话重试加卡），在多个 IP 间轮换直到绑上。`--max-rotations N`（默认3）控制最多切几个IP。

**调优旋钮（实测后的默认）**：
- `--max-rotations 3`：最多切3个IP（**只切没试过的不同IP**，跳过坏代理/不回老IP）。**连续3次 server-error → 早停**（判定换IP无效＝卡 BIN velocity，不是IP，别白切）。
- Save 等待：首次 60s，切IP重试只等 45s（换了新IP还不放行基本就不行）。`add_card(save_timeout=)` 可调。
- **`CARD_BIN_DAILY_CAP`（默认20）**：每个卡 BIN 当日加卡号数上限。`load_card`（spread）按 **BIN 维度摊匀**——把号摊到多个 BIN 上、每 BIN 当日限量，**绕开"同 BIN 一天铺太多号→Radar velocity"这个加卡根本墙**。**卡池要多 BIN/多发卡行才有效**。
- `--cooldown-hours 3`：加卡给不上→进**冷却队列**，3h内不再重试（`hyb_loop` 等到点自动续）。`--max-reopen 3`：同环境重开补加卡超3次→**永久放弃+删环境回收**（needphone/hcaptcha 直接放弃）。
- **`ADS_MAX_LAUNCH`（默认2）**：**启动浏览器并发闸**。`_ads_pace` 只节流API,挡不住"多号同时切IP→同时 spawn 浏览器内核→AdsPower挤崩(session deleted)"；这个闸限制同时启动的浏览器数(就绪后放名额,不限总开数)。机器强可调3-4,弱调1。
- **崩溃就地重启**：加卡中途浏览器崩(`session deleted`)→原环境 stop+start+重接管+接着加卡(最多2次),不整号放弃。配合发射闸＝防崩+崩了秒救 双保险。
- **校验框(hCaptcha)→换卡,不切IP**：可见 hCaptcha 是 Radar 判【这张卡】风险高的升级,2captcha 解不动。所以**换一张不同的卡(优选不同BIN)同会话再试**(`load_card(exclude=)`),绑别的卡可能就过了——换卡零成本,比来回切IP/换指纹环境省太多。换够2张(`MAX_CARD_SWAPS`)还校验框才终止。declined 同理换卡。2captcha 无人值守超时也砍到 30s。
- **卡表单没加载(unknown)→刷新重载 Stripe.js**：卡号框等不出=Payment Element 没初始化(累代理上加载慢)→刷新页面重开(2次,短等待)比重点按钮有效;根治靠换新代理。
- **切代理更聪明**：① 切之前 `proxy_ok` 验通(HEAD js.stripe.com)——死/慢代理直接跳过,不浪费~20s重启;② per-proxy 战绩(`state/proxy-stats.json`)——连续失败(dead/unknown)≥`PROXY_RETIRE_STREAK`(默认5)的代理**退役**、选IP时跳过(server-error 不计,那是卡velocity非代理)。
- **AdsPower 兜底 GC**：`cleanup_envs.py`(独立)+ 开跑前自动 GC,回收孤儿 hyb-* 环境(PW失败没key/崩没记录/没删干净的),三护栏:留续跑要重开的、跳过正开着的、跳过建龄<`--gc-min-age`的。
- **加卡已拟人化**：逐字符敲卡号(60-160ms随机)+进表单warmup滚动+点Save前停顿(对抗Radar行为遥测)。

**运营工具**：
- `python status.py [accounts.xxx.txt]` — **一屏仪表盘**：进度/冷却队列倒计时/被拒+永久放弃/卡池余量(够不够+几个BIN)/今日各BIN战绩(哪个被刷穿)。
- `card_capacity.py` 看每卡容量；`flag_accounts.py` 标问题号；`disable_cards.py`/`import_cards.py` 增删卡。
- 结果里 `timings`(pre_card/card/total 秒)+日志行首 `HH:MM:SS` → 可直接量每步耗时。
- 资源不泄漏：只成功删环境，但 needphone/hcaptcha/重开够多次/被拒 的环境都会**删掉回收**(state/bin-usage.json 记 per-BIN 当日战绩)。

- **环境只建一次**：建环境 → Playwright 注册/取Key/绑地址 → 关浏览器 → Selenium 重开同环境加卡。结果记 `env_id`/`env_serial`/`rotations`。
- **只有真正绑卡成功（card-bound）才删环境**；给不上则**保留环境**，留给续跑**重开**（profile 持久＝登录态/已绑地址都在，免去重注册+重登+重绑地址的几分钟开销）。
- `declined`（卡被拒）＝卡的问题不是IP → 同IP**换一张新卡**重试（坏卡已被卡池自动禁用），不浪费代理。
- 这套也大幅减少 AdsPower 建/删 churn（之前每次卡顿都删环境重来，把 AdsPower 跑劣化导致浏览器崩）。

## 3b. 断点续跑（不从头来）

结果写 `state/hybrid_results.jsonl`，**自动续跑**：

| 账号状态 | 行为 |
|---|---|
| 已绑卡 | 跳过 |
| 上次留了环境 + 有 key | **重开同一环境**（`reopen-env`）：已登录免重登、地址已绑 → 直接进加卡轮换循环 |
| 已注册 + 有 key（环境已删） | 新建环境，跳过 Playwright，直接 Selenium 登录→加卡 |
| 已注册 + 没 key | Playwright `mode=login` 直接登录（不走注册页+Turnstile），取Key+绑地址 |
| 全新号 | 完整 Playwright |
| 被拒(not allowed) | 登记 `banned_accounts.txt`，永久跳过 |

已有 key 的号 **复用 key，绝不重复建**。

---

## 4. 文件

**核心库**
- `common.py` — 共享 helper：AdsPower 本地 API(127.0.0.1+不走系统代理+全局限频)、chromedriver 自动配版、Page 类(跨 iframe 填表/点击/选择/失焦)、卡池、随机地址、结果正则。
- `adspower_env.py` — 环境建/启/停/删 + 分组 + 代理映射 + Windows 指纹。
- `captcha.py` — Turnstile/hCaptcha：CDP 注 hook + 2captcha 求解 + 注回 + 人工兜底。
- `cdp_fetch.py` — CDP Fetch 拦 Turnstile `api.js` 把 wrapper 拼进正文（等价 Playwright route，纯 Selenium 过 Turnstile 必需）。
- `firstmail.py` — 读注册魔法链接 / 验证码 + 改邮箱密码。
- `steps_auth.py` — 会话检测/登出/注册(Turnstile+魔法链接)/登录(含 factor-two 验证码)。
- `steps_key.py` — 关 onboarding 浮层 + 取 API Key。
- `steps_billing.py` — 加卡（Stripe 跨域 iframe 填卡、失焦校验、Save 耐心等 Radar、Auto Top-Up=已绑检测）。

**编排**
- `pipeline.py` / `run.py` — 纯 Selenium 单账号编排 / 批量入口。
- `hybrid_run.py` — 混合编排（PW→关→Selenium重开），支持并发 + 断点续跑。
- `hybrid-pw-stage.js`（在 `../playwright/`）— Playwright 那半：接管已启环境跑 register→取Key→绑地址，断开留浏览器。
- `hyb_loop.py` — 混合自重试循环（每轮换IP，跑到全绑）。`HYB_CONCURRENCY` 环境变量调并发。
- `_cardloop.py` — 纯 Selenium 加卡自重试循环。

**数据（全 gitignore）**：`accounts*.txt` `proxies*.txt` `state/`（结果/卡分配）`_*.log` `_*.png`。

---

## 5. 关键坑（已踩平，细节见记忆 openrouter-*）

- **纯 Selenium 过 Turnstile**：必须 CDP Fetch 拦 `api.js` 把 wrapper 拼进正文（文档级注入抓不到 Clerk 隐式渲染）。ws 要 `suppress_origin`(防 Chrome 403)、端口转 int、302 重定向放行。
- **注册邮箱验证是魔法链接**（`clerk.openrouter.ai/v1/verify`），不是验证码；登录的二次校验才是 6 位码。
- **Stripe 地址/卡是跨域 iframe**：填完最后字段要**失焦(发 TAB)**才算 complete，否则 Update Address/Save 点了不动。
- **加卡 Save 卡 "Saving" = Stripe Radar 后端审核门**（隐形 hCaptcha）：约抽签 ~50%，干净号+换IP重试能补齐。耐心等 ~100s 出终态，别急着重点。
- **Clerk Profile 弹窗**会挡绑地址→`BILLING_ERROR`：周期性关它，但**凡含 billing address/payment/card 的弹窗绝不碰**。
- **Auto Top-Up 出现 = 已有卡**：直接判已绑，别傻等加卡入口。
- **代理**：新环境必配代理；死代理报 Check Proxy Fail（纯 Selenium pipeline 会自动换下一个；混合用 socks5-only 池避开）。
- **AdsPower 本地 API** 限频 ~1req/s，并发时已全局节流。
