# shared-proxy-precheck

这个包负责：
**代理预检主链**。

也就是：
- 在正式注册主链开始之前
- 对当前代理做可用性、健康度、页面打开能力、站点入口可达性、业务首屏可用性等分阶段检查
- 输出统一的代理预检结果
- 成功时只确认进入最终阶段 `proxy-precheck-complete`

---

# 边界

## 输入
- 代理配置已由外层准备好
- browser / context / page 可由外层传入，或由预检链单独构造
- 站点 runtime 已由上层准备好

## 负责什么
- 代理连通性检查
- 代理基础网络健康检查
- 站点入口可达性检查
- 站点首屏/业务首页可用性检查
- 代理预检最终 success / failure / unknown 收口
- 各站点在代理预检链上的适配与配置
- 成功时输出 `nextStage=proxy-precheck-complete`

## 不负责什么
- 正式注册主链业务操作
- credential submit
- verification submit
- profile completion
- post-auth-ready
- account-delivery
- runner 层代理池调度策略
- 外部系统写入与消息通知

---

# 设计原则

- 继续沿用“公共阶段骨架 + 站点 adapter + profile + log”的架构风格
- 代理预检和正式注册主链分开，不把代理治理揉进业务阶段
- 每个阶段都有统一输入输出与字段语义
- 优先把边界、字段、注释、文档立起来，再逐步做实

---

# 当前规划的阶段

1. `proxy-connectivity`
2. `proxy-network-health`
3. `proxy-entry-reachability`
4. `proxy-site-ready`
5. `proxy-business-ready`
6. `proxy-precheck-result`

---

# 本地代理入口

当前已在包内提供本地联调入口：
- `local-proxies.txt`
- `local-proxy-loader.js`

当前建议格式：

```text
host:port:username:password
```

加载后统一映射为：

```js
{
  id,
  provider,
  protocol,
  host,
  port,
  username,
  password,
  raw,
}
```

注意：
- 具体代理账号密码放在 `local-proxies.txt`
- 站点规则仍只放在 Dreamina profile 里
- 不要把具体代理账号密码写进 profile JSON

---

# 后续

当前先落 Dreamina 草案。
后续如果接 OpenAI / Claude 等站点，继续沿用：
- 公共阶段模块
- 站点 adapter
- profile 三件套
