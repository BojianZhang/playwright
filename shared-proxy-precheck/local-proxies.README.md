# local-proxies.txt 说明

对应文件：
- `D:\playwright\shared-proxy-precheck\local-proxies.txt`

这个文件用于：
**在 `shared-proxy-precheck` 包内部维护本地联调用的代理列表。**

---

# 一、格式

每行一个代理，当前格式：

```text
host:port:username:password
```

示例：

```text
gate.ipfoxy.io:58688:customer-xxx:YBZrZzwysyHH7GU
```

---

# 二、用途

这个文件里的代理记录，后续应由 `shared-proxy-precheck` 内部的加载器读取并解析成统一对象：

```js
{
  host,
  port,
  username,
  password,
  protocol,
  id,
  provider,
  raw,
}
```

---

# 三、注意事项

- 这是本地联调入口，不是长期生产配置中心。
- 不要把这个文件再复制到 profile 规则文件里。
- profile 只放站点规则，不放具体代理账号密码。
- 后续如果要接 runner，可由 runner 读取这里，或由这里的解析器向 runner 输出统一代理对象。
