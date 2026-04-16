# verification 阶段日志示例

## success
- stage=verification-submit
- site=dreamina
- state=VERIFICATION_SUBMIT_OK
- nextStage=profile-completion
- signalStrength=strong
- settleStage=primary-success
- detectionSource=selector

## wrong code
- stage=verification-submit
- site=dreamina
- state=WRONG_VERIFICATION_CODE
- reason=DREAMINA_WRONG_VERIFICATION_CODE
- signalStrength=strong
- settleStage=primary-failure
- detectionSource=text
