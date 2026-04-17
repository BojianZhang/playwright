# runtime-params.md
# v0.0.3 配置与运行时参数完整说明
> 生成时间：2026-04-17 | 对应文件：Dreamina/0.0.3/config.json

---

## 一、配置优先级

```
CLI 参数 > config.json > 代码默认值（shared-utils/config-defaults.js）
```

通过 `shared-utils/config-doctor.js` 可在运行前做全量诊断。

---

## 二、config.json 完整字段说明

### `runMode`
| 字段 | 类型 | 默认值 | 合法值 |
|------|------|--------|--------|
| runMode | string | `"run"` | `run` / `test` |

---

### `batch`
| 字段 | 类型 | 默认值 | CLI 覆盖 | 说明 |
|------|------|--------|---------|------|
| concurrency | number | 1 | --concurrency N | 并发 Worker 数 |
| workerStatusIntervalMs | number | 10000 | - | 面板刷新间隔 ms |
| ignoreKnownExists | boolean | false | --ignore-known-exists | 跳过已注册过滤 |
| ignoreDone | boolean | false | --ignore-done | 跳过断点续跑过滤（EVO-13）|
| proxySelectionPolicy | string | `fresh-batch-no-history` | - | 代理选择策略 |

---

### `browser`
| 字段 | 类型 | 默认值 | CLI |
|------|------|--------|-----|
| headless | boolean | true | --headed/--headless |
| slowMo | number | 0 | --slow-mo N |
| blockedResourceTypes | string[] | `["image","media","font"]` | - |

---

### `proxy`
| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| maxRetriesPerAccount | number | 2 | 换代理最大重试次数 |
| evictOnHardFailure | boolean | true | 硬失败时剔除代理 |
| connectivityTimeoutMs | number | 8000 | S0 连通探测超时 ms |
| primaryTargetTimeoutMs | number | 10000 | S0 主目标超时 ms |
| secondaryTargetTimeoutMs | number | 8000 | S0 副目标超时 ms |
| enableSecondaryTarget | boolean | true | 启用副目标探测 |

---

### `noProxyPolicy` — GAP-2
| 字段 | 类型 | 默认值 | 合法值 |
|------|------|--------|--------|
| strategy | string | `skip_account` | `skip_account`/`retry`/`retry_then_defer`/`stop_batch` |
| retryMaxAttempts | number | 3 | - |
| retryIntervalMs | number | 5000 | - |
| deferQueueFile | string | `""` | - |

---

### `failureClassifier` — GAP-3
| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| proxyHardReasons | string[] | `[]` | 追加代理硬失败原因码 |
| businessReasons | string[] | `[]` | 追加业务失败原因码 |
| reasonOverrides | object | `{}` | 精确覆盖单个原因码分类 |

---

### `proxyHealthPool` — EVO-4/5/8
| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| softPenaltyThreshold | number | 2 | 软惩罚触发次数 |
| fallbackToWeakPool | boolean | true | 是否启用 DEGRADED_RUN |
| speedTierFilter | string[] | `["FAST","NORMAL","SLOW","UNKNOWN"]` | 允许调度档位 |
| fastThreshold | number | 75 | FAST 阈值（healthScore >= 75）|
| normalThreshold | number | 40 | NORMAL 阈值（healthScore >= 40）|

**speedTier 枚举：**
- `FAST` → healthScore >= 75
- `NORMAL` → healthScore >= 40
- `SLOW` → healthScore < 40
- `UNKNOWN` → 未经过 S0 预检（初次运行默认放行）

> 生产收紧：初次运行后改为 `["FAST","NORMAL"]`；DEGRADED_RUN 自动兜底。

---

### `resumePolicy` — EVO-13
| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| enabled | boolean | true | 启用断点续跑 |
| globalDoneFile | string | `batch-results/accounts-done.txt` | 跨批次 done 文件 |
| doneScope | string | `success+exists` | done 范围 |
| ignoreDone | boolean | false | 跳过过滤（等同 --ignore-done）|

---

### `site` — EVO-6
| 字段 | 必须 | 默认值 |
|------|------|--------|
| homeUrl | ✅ | `https://dreamina.capcut.com` |

---

### `log` — EVO-1/2/9
| 字段 | 类型 | 默认值 |
|------|------|--------|
| writeRunLog | boolean | true |
| writeFailureEvents | boolean | true |
| writeRunEndMarker | boolean | true |
| runLogAppend | boolean | true |

---

### `storageSafety` — GAP-1
| 字段 | 类型 | 默认值 |
|------|------|--------|
| enablePoolFileLock | boolean | true |
| writeRetryTimes | number | 2 |
| writeRetryDelayMs | number | 100 |

---

### `runtime`
| 字段 | 类型 | 默认值 |
|------|------|--------|
| workerAcquireTimeoutMs | number | 30000 |
| stageFallbackTimeoutMs | number | 60000 |

---

## 三、CLI 参数完整清单

| 参数 | 对应配置 |
|------|---------|
| --concurrency N | batch.concurrency |
| --account-start N | 账号起始索引 |
| --account-limit N | 账号最大数量 |
| --proxy-start N | 代理起始索引 |
| --headed | browser.headless=false |
| --headless | browser.headless=true |
| --slow-mo N | browser.slowMo |
| --ignore-known-exists | batch.ignoreKnownExists=true |
| --ignore-done | batch.ignoreDone=true |

---

## 四、相关文件清单

| 文件 | 说明 |
|------|------|
| `Dreamina/0.0.3/config.json` | 主配置文件 |
| `shared-utils/config-defaults.js` | 全量默认值骨架 |
| `shared-utils/config-schema.js` | 字段类型与约束定义 |
| `shared-utils/config-doctor.js` | 运行前诊断工具 |
| `shared-utils/file-utils.js` | 公共文件/路径工具 |

---

## 五、运行前置条件检查用法

```javascript
const { diagnoseConfigFile } = require('../../shared-utils/config-doctor');
const result = diagnoseConfigFile(CONFIG_PATH, { checkFiles: true, verbose: true });
if (!result.ok) {
  console.error('配置诊断失败，请修复以上 ERROR 后重试');
  process.exit(1);
}
```
