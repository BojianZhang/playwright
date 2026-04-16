# 阶段 2（credential submit）日志摘取模板

真实跑阶段 2 后，建议按下面格式摘日志：

```text
【基础上下文】
账号：
代理：
模式：
URL：

【form ready】
...

【fill email/password】
...

【submit】
...

【confirm result】
...

【最终失败 reason】
...
```

重点看：
- form ready 是否成功
- email/password 是否真正可填
- submit 是否成功触发
- 是否进入验证码阶段
- 是否命中 existing account / rejected / rate limited
