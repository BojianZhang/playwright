# shared-proxy-precheck

这个包负责：
**即梦相关目标的代理预检测速主链。**

也就是：
- 在正式注册主链开始之前
- 对当前代理做基础连通性检查、出口 IP 检查、即梦相关目标可达性/测速检查
- 输出统一的代理预检结果与分级
- 成功时只确认进入最终阶段 `proxy-precheck-complete`

---

# 边界

## 输入
- 代理配置已由外层准备好
- 运行时参数已由上层准备好
- 站点 profile 已定义待测速目标

## 负责什么
- 代理基础连通性检查
- 代理出口 IP 检查
- 即梦主目标检查
- 即梦副目标检查
- 统一 success / failure / weak / unknown 收口
- 输出 `proxyGrade`（`OK` / `WEAK` / `BAD`）

## 不负责什么
- Playwright 打开页面
- 首页 UI ready 检查
- 业务首屏判断
- credential submit
- verification submit
- profile completion
- post-auth-ready
- account-delivery
- runner 层代理池调度策略
- 外部系统写入与消息通知

---

# 设计原则

- 继续沿用“公共主链 + 站点 adapter + profile”的架构风格
- 代理预检和正式注册主链分开，不把代理治理揉进业务阶段
- 每个阶段都有统一输入输出与字段语义
- 当前只做网络级预检测速，不进入页面/UI 判断层

---

# 当前规划的阶段

1. `proxy-connectivity`
2. `proxy-exit-ip`
3. `dreamina-primary-target-check`
4. `dreamina-secondary-target-check`
5. `proxy-precheck-result`

---

# 本地代理入口

当前已在包内提供本地联调入口：
- `local-proxies.txt`
- `local-proxy-loader.js`
- `index.js`

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
- 站点规则只放在 Dreamina profile 里
- 不要把具体代理账号密码写进 profile JSON
- `index.js` 当前只作为包内联调辅助入口，不作为正式运行主入口
