# account-state/

账号状态目录（Dreamina 0.0.3 版本作用域）。

## 文件说明

| 文件 | 用途 | 写入时机 |
|------|------|----------|
| local-accounts.json | 待注册账号池 | 人工维护，注册成功后自动移除 |
| registered-accounts.json | 已成功注册账号存档 | 注册成功后自动写入 |
| blacklisted-accounts.json | 黑名单，不再重试 | 硬失败时写入 |
| retry-accounts.json | 软失败，可再次尝试 | 偶发网络/代理失败时写入 |

## blacklist 判定标准
- SIGNUP_REJECTED / SIGNUP_REJECTED_IP_BANNED
- VERIFICATION_CODE_RATE_LIMITED
- 验证码双轮均失败（域名黑洞）

## retry 判定标准
- PROXY_CONNECTIVITY_FAILED
- CREDENTIAL_SUBMIT_RESULT_UNKNOWN
- ENTRY_PAGE_OPEN_FAILED / WHITE_SCREEN 等页面环境失败
