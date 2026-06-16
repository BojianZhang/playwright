# selenium-e2e 目录地图

按职责分包后,根目录只剩**入口+编排**,其余按角色收进子目录。读代码先看这里定位。

```
selenium-e2e/
  run.py  hybrid_run.py  hyb_loop.py  pipeline.py   ← 入口 + 编排(留根)
  common/     共享 helper(日志/AdsPower API/driver/ledger/Page/config)
  steps/      流程阶段(注册/取key/账单)
  cardbind/   加卡实现(Fix C/B)
  services/   外部服务(AdsPower环境/验证码/邮箱/CDP)
  tools/      运营工具(独立跑,~18 个)
  scratch/    开发探针(已归档,见 scratch/README.md)
  test_helpers.py  test_fingerprint.py   *.md   state/   data 软链
```

## 入口 · 跑业务流程(在 selenium-e2e/ 下直接 `python <名>.py`)

| 文件 | 作用 |
|------|------|
| `run.py` | 纯 Selenium 引擎:接管 AdsPower 跑注册→取key→绑地址→加卡全流程 |
| `hybrid_run.py` | 混合接力引擎:Playwright 注册/取key/绑地址 → 关浏览器 → Selenium 重开同环境加卡(过 Stripe 跨域 iframe) |
| `hyb_loop.py` | 循环跑 hybrid:每轮换 IP/指纹重试没绑上的号,直到全绑成或到最大轮数 |
| `pipeline.py` | `run_account` 单账号编排(被 `run.py` 调,也是库) |

> 入口留在根目录:它们是手敲命令、文档(ARCHITECTURE/README)按 `selenium-e2e/run.py` 路径引用、且 `hybrid_run.py` 被外部当子进程拉。

## 包 · 被入口/彼此以 `from <包> import <模块>` 导入

- **`common/`** —— 共享 helper 单一来源(`import common` 不变;内部 paths/base/adspower/driver/ledger/layout/page/config)
- **`steps/`** —— `steps_auth`(注册/登录/验证)、`steps_key`(取key双轨)、`steps_billing`(账单+加卡编排)
- **`cardbind/`** —— `fixc_core`(Fix C 原生CDP核)、`fixc_bind`(单号绑卡)、`fixc_parallel`(并发runner)、`fixb_bind`(Fix B runner)
- **`services/`** —— `adspower_env`(环境)、`captcha`(Turnstile/hCaptcha)、`firstmail`(邮箱)、`cdp_fetch`(拦api.js)、`cdp_raw`(裸CDP)

> 依赖方向单向无环:`入口/pipeline → steps → cardbind → services → common`。
> 包内被当脚本直接跑的文件(`cardbind/fixc_parallel`、`fixb_bind` 等)顶部有 path shim,所以 `python cardbind/fixc_parallel.py` 照样能解析 `import common`。

## 运营工具 · `tools/`(独立跑:`python tools/<名>.py`)

`status`(仪表盘) `watch_results`(事件流) `cards_watch`/`cards_failed`(卡池监视) `card_capacity`(容量测试)
`import_cards`/`disable_cards`/`reactivate_cards`(卡增删启停) `block_bin`(拉黑BIN) `proxy_score`(代理评分)
`cleanup_envs`(清环境) `flag_accounts`(标号) `report_b3d`(报表) `fixc_probe`(CDP探针)
`addcard`/`purchase`/`verify_card`(独立加卡/充值/核验) `卡查询`
`fingerprint_check`(指纹自测/验收:用 Fingerprint Pro 验 AdsPower 随机指纹是否唯一+稳定,走原生CDP不污染 bot/tampering;**不是**指纹生成器、过它≠过Radar)

> 每个工具顶部有 path shim,且按 `__file__` 定位 state/data 的已锚定到 selenium-e2e/(移动后路径不变)。

### ⚠ 两个 import 即执行的脚本

`tools/purchase.py` 和 `tools/verify_card.py` **没有 `__main__` 守卫**,`import` 它们会立刻启动浏览器
(`purchase.py` 还会发起真实充值尝试)。只能 `python tools/purchase.py` 直接跑,**绝不要 import**(批量 import 冒烟会踩雷)。
