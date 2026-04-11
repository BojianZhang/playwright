# 第六阶段日志示例

## 成功示例

- `dreamina.accountDelivery.ready | source=url | value=/workspace | strength=weak | waitStepMs=900`
- `dreamina.accountDelivery.summary | source=account | value=email | strength=medium`
- `dreamina.accountDelivery.payload | source=payload | value=required-fields-ready | strength=strong`
- `dreamina.accountDelivery.result | state=DELIVERY_COMPLETE | source=payload | value=email | settleStage=secondary-success`

## 未收敛示例

- `dreamina.accountDelivery.ready | source=url | value=/home | strength=weak | waitStepMs=900`
- `dreamina.accountDelivery.summary | source= | value= | strength=`
- `dreamina.accountDelivery.payload | source= | value= | strength=`
- `dreamina.accountDelivery.result | state=ACCOUNT_DELIVERY_RESULT_UNKNOWN | source= | value= | settleStage=none`

## 失败示例

- `dreamina.accountDelivery.ready | source=text | value=Try again | strength=weak | waitStepMs=900`
- `dreamina.accountDelivery.result | state=ACCOUNT_DELIVERY_FAILED | source=text | value=Try again | settleStage=primary-failure`
- `dreamina.accountDelivery.classify | reason=ACCOUNT_DELIVERY_FAILED | siteReason=DREAMINA_ACCOUNT_DELIVERY_FAILED | hardFailure=false`
