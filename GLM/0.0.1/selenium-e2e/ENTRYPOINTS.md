# selenium-e2e 入口与结构(GLM / z.ai)

## 入口
- `run.py` —— 批量入口:读账号/代理/配置 → 逐号建 AdsPower 环境跑全流程 → 删环境 → 写 `state/results.jsonl`。
  常用:`python run.py --accounts a.txt --proxies p.txt --do-apikey --do-subscribe --plan max --cycle monthly [--real-charge]`
- `pipeline.py` —— 单账号编排状态机:`env → auth(register|login) → apikey → subscribe`。被 run.py 调用。
- `test_pipeline_logic.py` —— 离线回归(续跑/订阅去重/失败归因/容量账本/滑块轨迹)。`python test_pipeline_logic.py`。

## 包结构
- `common/` —— 基础设施(原样复用为主):
  - `paths/base` 路径/日志/URL/正则/原子写/跨进程锁;`config` 读密钥+随机地址;`attribution` 失败归因(register→apikey→subscribe)。
  - `driver` 接管 AdsPower Chrome + 隐身;`adspower` 本地 API;`page` 跨 iframe 填表/点击;`selectors` 元素覆盖(ORSEL_*);`ledger` 卡池/代理/充值容量账本;`layout` 多窗网格;`uikeys` 跨平台清空。
- `steps/` —— z.ai 流程:
  - `steps_auth` 注册(Sign in→Continue with Email→Sign up→填表→滑块→Create Account→邮箱链接验证→Complete Registration)/ 登录(滑块→Sign in);`register_or_login` 调度。
  - `steps_apikey` 进 `manage-apikey` → Add API Key → 填名 → Create → 抓 key(网络钩子/剪贴板/DOM 三兜底);`inject_key_capture` 导航前注入。
  - `steps_subscribe` 进 `subscribe` 选周期+套餐 Subscribe → `payment` 填卡+地址+勾同意 →(real_charge 才)Confirm → 轮询 Payment Success/Failed/Invalid amount。
- `services/` —— 外部能力:
  - `slider` 2Captcha Coordinates 取缺口坐标 + 本地拟人可信 CDP 拖拽(`SLIDER_SCALE/OFFSET/ATTEMPTS` 校准)。
  - `firstmail` firstmail.ltd REST 读验证邮件 + 抽 z.ai `verify_email` 链接(`extract_zai_verify_link`)。
  - `adspower_env` 建/删环境 + 随机指纹 + 代理;`cdp_raw` 极简原生 CDP(可信 Input,含 `mouse_drag` 滑块拖拽)。
- `tools/` —— 运维脚本(状态/卡池/清环境等,复用自模板)。
- `state/` —— 运行态(results.jsonl / sel_account_progress.json / 卡池账本;gitignore)。

## 账号/代理文件格式
- 账号:每行 `email:邮箱密码`(邮箱密码=firstmail 读信密码,也是 z.ai 注册所设密码,除非用 `--unified-pw` 覆盖)。
- 代理:每行 `host:port:user:pass` 或 `socks5://user:pass@host:port`。
