# proxy-precheck-runner.js 使用说明

对应文件：
- `D:\playwright\proxy-precheck-runner.js`

这个文件是：
**包外纯网络预检运行入口**。

它负责：
- 从 `shared-proxy-precheck/local-proxies.txt` 读取代理
- 选择一个本地代理
- 调用 `shared-proxy-precheck/stages/proxy-precheck.js`
- 输出统一预检结果

它不负责：
- Playwright 启动浏览器
- 打开即梦页面
- 页面 UI ready 判断

---

# 一、如何运行

在 `D:\playwright` 目录下执行：

```powershell
node .\proxy-precheck-runner.js
```

默认会取：
- `local-proxies.txt` 的第 0 条代理

如果要指定第几个代理：

```powershell
node .\proxy-precheck-runner.js 0
node .\proxy-precheck-runner.js 1
node .\proxy-precheck-runner.js 2
node .\proxy-precheck-runner.js 3
node .\proxy-precheck-runner.js 4
```

这里的数字就是：
- `preferredIndex`

也就是从 `local-proxies.txt` 里按 0 开始取第几个代理。

---

# 二、代理信息填在哪里

当前本地联调代理入口：
- `D:\playwright\shared-proxy-precheck\local-proxies.txt`

当前格式：

```text
host:port:username:password
```

每行一个代理。

---

# 三、运行成功后会输出什么

运行后会直接在终端打印 JSON 结果。
其中会包含：
- `success`
- `state`
- `reason`
- `proxyGrade`
- `proxySummary`
- `detail`

说明：
- `proxySummary` 是脱敏摘要
- 不会直接把明文密码打到摘要里

---

# 四、退出码

- 预检成功：退出码 `0`
- 预检失败：退出码 `1`

---

# 五、当前边界

这个 runner 当前只做：
- 本地代理读取
- 单代理纯网络预检
- Dreamina 相关目标测速

它当前不做：
- 自动切换下一个代理
- 批量轮询所有代理
- runner 全链接入
- 正式注册链调用
