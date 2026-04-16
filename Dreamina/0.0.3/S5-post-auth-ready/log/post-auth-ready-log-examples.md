# 第五阶段日志示例

## 成功示例

- `dreamina.postAuth.ready | source=url | value=/workspace | strength=weak | waitStepMs=900`
- `dreamina.postAuth.session | source=local-storage | value=userInfo | strength=medium`
- `dreamina.postAuth.ui | source=user-panel | value=.user-avatar | strength=strong`
- `dreamina.postAuth.result | state=REGISTRATION_COMPLETE | source=selector | value=.workspace-shell | settleStage=secondary-success`

## 未收敛示例

- `dreamina.postAuth.ready | source=url | value=/home | strength=weak | waitStepMs=900`
- `dreamina.postAuth.session | source= | value= | strength=`
- `dreamina.postAuth.ui | source= | value= | strength=`
- `dreamina.postAuth.result | state=POST_AUTH_RESULT_UNKNOWN | source= | value= | settleStage=none`

## 失败示例

- `dreamina.postAuth.ready | source=text | value=Try again | strength=weak | waitStepMs=900`
- `dreamina.postAuth.result | state=POST_AUTH_FAILED | source=text | value=Try again | settleStage=primary-failure`
- `dreamina.postAuth.classify | reason=POST_AUTH_FAILED | siteReason=DREAMINA_POST_AUTH_FAILED | hardFailure=false`
