# 第五阶段日志模板

建议日志主线：

1. `postAuth.ready`
2. `postAuth.session`
3. `postAuth.ui`
4. `postAuth.result`
5. `postAuth.classify`

---

## 示例骨架

- `dreamina.postAuth.ready | source=selector | value=.workspace-shell | strength=strong | waitStepMs=900`
- `dreamina.postAuth.session | source=cookie | value=sessionid | strength=medium`
- `dreamina.postAuth.ui | source=user-panel | value=.user-avatar | strength=strong`
- `dreamina.postAuth.result | state=REGISTRATION_COMPLETE | source=selector | value=.workspace-shell | settleStage=primary-success`
- `dreamina.postAuth.classify | reason=POST_AUTH_RESULT_UNKNOWN | siteReason=DREAMINA_POST_AUTH_RESULT_UNKNOWN | hardFailure=false`
