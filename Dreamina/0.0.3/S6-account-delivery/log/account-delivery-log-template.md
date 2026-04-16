# 第六阶段日志模板

建议日志主线：

1. `accountDelivery.ready`
2. `accountDelivery.summary`
3. `accountDelivery.payload`
4. `accountDelivery.result`
5. `accountDelivery.classify`

---

## 示例骨架

- `dreamina.accountDelivery.ready | source=selector | value=.workspace-shell | strength=strong | waitStepMs=900`
- `dreamina.accountDelivery.summary | source=account | value=email | strength=medium`
- `dreamina.accountDelivery.payload | source=payload | value=required-fields-ready | strength=strong`
- `dreamina.accountDelivery.result | state=DELIVERY_COMPLETE | source=payload | value=email | settleStage=primary-success`
- `dreamina.accountDelivery.classify | reason=ACCOUNT_DELIVERY_RESULT_UNKNOWN | siteReason=DREAMINA_ACCOUNT_DELIVERY_RESULT_UNKNOWN | hardFailure=false`
