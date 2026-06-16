'use strict';
// ⟦共享规范实现(控制台配置 schema · OR↔GLM 共享) · 改这里;各项目 web/selectors-schema.js 是 re-export shim,勿改⟧ 见 shared-utils/README.md

// ═══════════════════════════════════════════════════════════════════════
// 元素选择器注册表(后端,唯一真相源)— 规范实现(历史出处 Openrouter/0.0.1/web/selectors-schema.js)
//
// 把易变的关键元素「定位规则」外置:OpenRouter 改版导致「元素找不到」时,在「元素维护」页改这里、不改代码,两引擎共用。
// kind:'css' = 给 Selenium find_elements 的 CSS 选择器(可多个,按序尝试);
//       'text'= 按可见文本/正则在 button/[role=button]/a 等里定位(React 文案按钮)。
// scope:主要 'selenium'(纯Selenium 的注册/登录/取key);Playwright 引擎随后接同一份注册表。
// builtin:当前代码里的内置默认 —— 页面展示给你看「现在用的是啥」,且【覆盖留空时回落到它】(行为不变)。
// 覆盖值经 buildEnv 注成 ORSEL_<ID>(多个用 || 分隔),Python 的 common.selectors.sel() 读取。
// ═══════════════════════════════════════════════════════════════════════

const STEPS = [
  // ── 注册 / 登录(steps_auth)──────────────────────────────────────────────
  { id: 'signup_firstname', env: 'ORSEL_SIGNUP_FIRSTNAME', kind: 'css', scope: 'selenium', group: '注册 / 登录',
    label: '注册·名字框', desc: '注册表单 First name 输入框,填随机名。', builtin: ['#firstName-field'] },
  { id: 'signup_lastname', env: 'ORSEL_SIGNUP_LASTNAME', kind: 'css', scope: 'selenium', group: '注册 / 登录',
    label: '注册·姓氏框', desc: '注册表单 Last name 输入框,填 M。', builtin: ['#lastName-field'] },
  { id: 'signup_email', env: 'ORSEL_SIGNUP_EMAIL', kind: 'css', scope: 'selenium', group: '注册 / 登录',
    label: '注册·邮箱框', desc: '注册表单 Email 输入框,填账号邮箱。', builtin: ['#emailAddress-field'] },
  { id: 'signup_password', env: 'ORSEL_SIGNUP_PASSWORD', kind: 'css', scope: 'selenium', group: '注册 / 登录',
    label: '注册·密码框', desc: '注册表单 Password 输入框,填账号密码(≥8位)。', builtin: ['#password-field'] },
  { id: 'signup_legal', env: 'ORSEL_SIGNUP_LEGAL', kind: 'css', scope: 'selenium', group: '注册 / 登录',
    label: '注册·同意条款勾选', desc: '注册表单底部 I agree 复选框,必须勾上否则 Continue 灰。', builtin: ['#legalAccepted-field'] },
  { id: 'signin_identifier', env: 'ORSEL_SIGNIN_IDENTIFIER', kind: 'css', scope: 'selenium', group: '注册 / 登录',
    label: '登录·邮箱/标识框', desc: '老号登录第一步的邮箱框。', builtin: ['#identifier-field'] },
  { id: 'otp_input', env: 'ORSEL_OTP_INPUT', kind: 'css', scope: 'selenium', group: '注册 / 登录',
    label: '登录OTP·验证码框', desc: '登录二次验证(factor-two)填 6 位邮箱验证码的框。',
    builtin: ['input[inputmode="numeric"]', 'input[name="code"]', 'input[autocomplete="one-time-code"]', 'input[id*="code"]'] },

  // ── 取key 向导(steps_key)────────────────────────────────────────────────
  { id: 'wizard_individual', env: 'ORSEL_WIZARD_INDIVIDUAL', kind: 'text', scope: 'selenium', group: '取key 向导',
    label: '向导·选 Individual 卡片', desc: '新号 onboarding「How will you be using OpenRouter?」里那张 Individual 卡片(是 <button>,按描述文本定位)。点它进 workspace。',
    builtin: ['Build side projects', 'explore models', 'prototype ideas'] },
  { id: 'wizard_survey_radio', env: 'ORSEL_WIZARD_SURVEY_RADIO', kind: 'text', scope: 'selenium', group: '取key 向导',
    label: '向导·问卷 radio 选项', desc: '问卷「Where did you first hear about OpenRouter?」选一个 radio(优先 Other/Not sure),选了才能 Continue。',
    builtin: ['Other / Not sure', 'Not sure', 'Google'] },
  { id: 'wizard_continue', env: 'ORSEL_WIZARD_CONTINUE', kind: 'text', scope: 'selenium', group: '取key 向导',
    label: '向导·推进按钮', desc: 'Welcome / 选完 Individual / 问卷之后的「继续」按钮。', builtin: ['Continue', 'Get started', 'Next', "Let's go"] },
  { id: 'wizard_allset', env: 'ORSEL_WIZARD_ALLSET', kind: 'text', scope: 'selenium', group: '取key 向导',
    label: '向导·进 Dashboard', desc: '「You\'re all set!」之后的 Go to Dashboard 按钮。', builtin: ['Go to Dashboard'] },
  { id: 'newkey_button', env: 'ORSEL_NEWKEY_BUTTON', kind: 'text', scope: 'selenium', group: '取key 向导',
    label: 'Dashboard·新建 Key 按钮', desc: 'keys 页右上「+New Key」按钮(老号/落空 dashboard 建 key 时点它)。', builtin: ['New Key', 'Create Key', 'Create API Key', 'Create'] },
  { id: 'key_name_input', env: 'ORSEL_KEY_NAME_INPUT', kind: 'css', scope: 'selenium', group: '取key 向导',
    label: '建key弹窗·名字框', desc: '点 New Key 后弹窗里给 key 命名的输入框(别填进 dashboard 的搜索框)。', builtin: ['[role=dialog] #name', '#name', 'input[name="name"]'] },

  // ── 账单 / 地址(steps_billing / 向导支付)────────────────────────────────
  { id: 'address_line1', env: 'ORSEL_ADDRESS_LINE1', kind: 'text', scope: 'selenium', group: '账单 / 地址',
    label: '账单·地址行1框', desc: '账单地址 Address line 1 输入框(按 label/autocomplete/name 匹配,填街道)。', builtin: ['address line 1', 'address-line1', 'line1', 'address1'] },
  { id: 'pay_complete', env: 'ORSEL_PAY_COMPLETE', kind: 'text', scope: 'selenium', group: '账单 / 地址',
    label: '账单·填完地址推进', desc: '填完地址后的「Complete address details / Continue / Save」按钮。', builtin: ['Complete address details', 'Continue', 'Save'] },
  { id: 'pay_later', env: 'ORSEL_PAY_LATER', kind: 'text', scope: 'selenium', group: '账单 / 地址',
    label: '账单·稍后再说', desc: '向导支付/积分步的「I\'ll do this later」跳过链接。', builtin: ["I'll do this later", 'do this later', 'Skip for now', 'Maybe later'] },
];

const KEYS = new Set(STEPS.map((s) => s.id));

// 只注【用户显式设了非空覆盖】的;空=不注入=Python 用内置默认(builtin)。
function envPatch(stored) {
  const s = stored || {};
  const env = {};
  for (const st of STEPS) {
    const v = s[st.id];
    if (v !== undefined && v !== null && String(v).trim() !== '') env[st.env] = String(v).trim();
  }
  return env;
}

module.exports = { STEPS, KEYS, envPatch };
