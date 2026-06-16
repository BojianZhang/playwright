# dreamina-profile-completion-profile 字段说明

对应文件：
- `D:\playwright\shared-profile-completion\dreamina\profiles\dreamina-profile-completion-profile.json`

这个文件解释 Dreamina 阶段 4 profile 里每个字段的作用。

---

# 一、建议结构

```json
{
  "name": "DreaminaProfileCompletionStage",
  "profileReady": {
    "texts": [],
    "selectors": []
  },
  "birthday": {
    "yearSelectors": [],
    "monthSelectors": [],
    "daySelectors": [],
    "submitSelectors": [],
    "submitTexts": []
  },
  "successSignals": {
    "texts": [],
    "selectors": []
  },
  "failureSignals": {
    "inputInvalid": [],
    "submitFailed": [],
    "inlineErrors": []
  },
  "nextStageSignals": {
    "postAuthReady": {
      "texts": [],
      "selectors": []
    }
  }
}
```

---

# 二、字段说明

## `name`
- 类型：`string`
- 含义：当前 profile 名称

## `profileReady`
用于判断页面是否已经进入 birthday / profile-completion 阶段。

## `birthday`
用于定义 birthday 输入与提交相关的 selector/text。

### `birthday.yearSelectors`
- year 输入候选

### `birthday.monthSelectors`
- month 输入候选

### `birthday.daySelectors`
- day 输入候选

### `birthday.submitSelectors`
- submit / next 按钮 selector 候选

### `birthday.submitTexts`
- submit / next 按钮文本候选

## `successSignals`
用于定义资料填写成功推进的信号。

## `failureSignals`
用于定义阶段 4 失败提示。

## `nextStageSignals.postAuthReady`
用于定义下一阶段 `post-auth-ready` 的可达性信号。
