# proxy-precheck-runner.js 使用说明

对应文件：
- `D:\playwright\proxy-precheck-runner.js`

这个文件是：
**包外纯网络预检运行入口**。

它负责：
- 从 `shared-proxy-precheck/local-proxies.txt` 读取代理
- 选择一个或多个本地代理
- 调用 `shared-proxy-precheck/stages/proxy-precheck.js`
- 先输出“出口IP + 测速 + 等级”的人话摘要
- 再输出完整 JSON 结果

它不负责：
- Playwright 启动浏览器
- 打开即梦页面
- 页面 UI ready 判断

---

# 一、如何运行

## 1. 单代理预检

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
```

---

## 2. 全部代理并发预检

```powershell
node .\proxy-precheck-runner.js --all
```

默认并发数：
- `3`

如果要指定并发数：

```powershell
node .\proxy-precheck-runner.js --all 5
```

---

# 二、运行输出

## 人话摘要
每条代理都会先输出一行摘要，例如：

```text
[Proxy Precheck] #1 local-proxy-1 | Grade=OK | ExitIP=129.227.139.156 | Connectivity=1390ms | Primary=925ms | Secondary=977ms
```

## 完整 JSON
摘要后会继续输出完整 JSON，便于进一步排查。

---

# 三、代理信息填在哪里

当前本地联调代理入口：
- `D:\playwright\shared-proxy-precheck\local-proxies.txt`

当前格式：

```text
host:port:username:password
```

每行一个代理。

---

# 四、退出码

- 全部成功：退出码 `0`
- 任一失败：退出码 `1`

---

# 五、当前边界

这个 runner 当前只做：
- 本地代理读取
- 单代理 / 多代理并发纯网络预检
- Dreamina 相关目标测速

它当前不做：
- 打开页面
- 自动切换注册主链
- runner 全链接入
