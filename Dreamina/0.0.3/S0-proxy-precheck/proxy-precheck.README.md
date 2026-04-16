# S0-proxy-precheck — 阶段说明

**文件位置**：`Dreamina/0.0.3/S0-proxy-precheck/`
**阶段标识**：`S0`
**阶段名称**：代理预检（Proxy Precheck）

---

## 一、职责边界（BOUNDARY）

| | 说明 |
|---|---|
| ✅ 负责 | 代理 TCP 连通性检测 |
| ✅ 负责 | 代理出口 IP 获取与验证 |
| ✅ 负责 | Dreamina 主目标（dreamina.capcut.com）可达性检测 |
| ✅ 负责 | Dreamina 副目标可达性检测 |
| ✅ 负责 | 代理质量分级（`proxyGrade`: OK / WEAK / BAD） |
| ✅ 负责 | 代理健康状态持久化（`proxy-health-store.json`） |
| ✅ 负责 | 代理池加载与解析（`proxies.txt` → 代理对象列表） |
| ❌ 不负责 | 浏览器启动（无 Playwright 操作） |
| ❌ 不负责 | 账号管理（不读写 local-accounts.json） |
| ❌ 不负责 | 任何注册业务逻辑（登录 / 验证码 / 资料填写） |
| ❌ 不负责 | 跨阶段状态传递（只负责产出 `proxyPrecheckResult`） |

---

## 二、目录结构

```
S0-proxy-precheck/
├── data/                              ← 运行时数据（程序读写 / 人工配置）
│   ├── proxies.txt                   ← 代理池输入（你手动填写，格式 host:port:user:pass）
│   ├── bad-proxies.txt               ← 代理黑名单（程序追加写，人工可读）
│   └── proxy-health-store.json       ← 代理健康评分数据（JSON，程序读写）
│
├── profiles/                         ← Dreamina 专属检测参数 profile
│   └── dreamina-proxy-precheck-profile.json
│
├── local-proxy-loader.js             ← 代理池加载器（解析 proxies.txt → 代理对象列表）
├── proxy-health-store.js             ← 代理健康状态读写（loadProxyHealthStore / saveProxyHealthStore）
├── proxy-precheck-adapter.js         ← S0 stage adapter（连通性 / IP / 主副目标 / 分级）
│
├── proxy-precheck.README.md          ← 本文件：S0 阶段说明
└── proxy-precheck-adapter.md         ← adapter 入参、方法签名及返回字段完整说明
```

---

## 三、核心文件说明

### `local-proxy-loader.js`
加载并解析 `data/proxies.txt`，输出统一代理对象列表。
- 支持 `host:port:user:pass` 格式
- 自动从 username 中解析国家码（`cc-XX` 模式）
- 过滤格式错误行，跳过 `#` 注释行

### `proxy-health-store.js`
代理健康状态的持久化读写模块。
- 每次批量运行后将代理评分写入 `data/proxy-health-store.json`
- 提供 `isProxyHardBlocked()` 用于过滤硬失败代理

### `proxy-precheck-adapter.js`
S0 阶段的 Dreamina 专属 adapter，实现 `shared-proxy-precheck` 框架契约。
- 依次执行：连通性 → 出口 IP → 主目标 → 副目标 → 分级收口
- 输出 `proxyGrade`（OK / WEAK / BAD）供后续阶段使用

### `data/proxies.txt`
代理池输入文件，每行一条代理，格式：
```
host:port:username:password
```
`#` 开头为注释行，空行自动跳过。

### `data/bad-proxies.txt`
程序自动写入的代理黑名单文本（人工可读）。
格式与 `proxies.txt` 相同，每行为一条已确认失效代理的原始字符串。
> 真正的生产判断依据是 `proxy-health-store.json` 中的 `status` 字段，`bad-proxies.txt` 仅作为辅助日志。

### `data/proxy-health-store.json`
代理健康状态结构化存储（JSON），由 `proxy-health-store.js` 维护。
字段说明见 `proxy-precheck-adapter.md`（入参、方法签名与返回字段完整说明）。

---

## 四、阶段产出

S0 执行成功后对外输出 `proxyPrecheckResult`（即 `confirmProxyPrecheckResult` 的返回值）：

```js
{
  ok: true,                               // 是否通过预检（WEAK 也算通过）
  proxyGrade: 'OK',                       // 代理质量等级：OK / WEAK / BAD
  capabilityGrade: 'ENTRY_READY_CAPABLE', // 能力等级（从低到高）：
                                          //   DEAD / TUNNEL_ONLY / HTTP_REACHABLE /
                                          //   HTTP_REACHABLE_BUT_BLANK / HOMEPAGE_USABLE /
                                          //   ENTRY_READY_CAPABLE
  businessGrade: 'OK',                    // 业务等级：BAD / WEAK / OK / STRONG
  healthScore: 80,                        // 综合能力得分 0-100（各子检查贡献分之和）
  state: 'PROXY_PRECHECK_OK',             // 最终状态码（失败时为 PROXY_PRECHECK_BAD 或 PROXY_PRECHECK_WEAK_OK）
  source: 'business-target-checks',       // 当前结果由哪个检查项收口
  settleStage: 'result-confirmation',     // 收口层：connectivity / result-confirmation
  retryCount: 0,                          // 预检链内部重试次数（当前版本恒为 0）
  elapsedMs: 4200,                        // 本阶段总耗时（ms）
}
```

> 字段完整说明见 `proxy-precheck-adapter.md`。
