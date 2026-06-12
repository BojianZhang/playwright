# OpenRouter 登录 + 加卡 —— AdsPower RPA 流程指南

---
# 📋 一步一步搭建（从零到跑通）

## 准备：在环境里填好账号
编辑该 AdsPower 环境 → 账号平台 → 平台账户=OpenRouter 邮箱、平台密码=密码。
（这样系统变量 user_name/password 自动带上该号，脚本直接读。）

## 节点逐个加（左侧拖到画布，按顺序连线）

① 开始流程（默认就有）

② 访问网站：网址 https://openrouter.ai/sign-in ；等待 8000 毫秒

③ 执行JS脚本 —— 登录（贴“片段1增强版”整段）
   - 注入变量：系统变量 勾 user_name、password
   - 返回值保存至：新建流程变量 loginR

④ 等待时间 5000

⑤ 条件判断（可选）：loginR == NEED_CODE → 取码；== LOGGED_IN → 直接跳到 ⑨

⑥ 获取邮件 —— 取验证码
   - IMAP；服务器 imap.firstmail.ltd；端口 993；SSL 开
   - 账号=邮箱、密码=邮箱密码（Firstmail 的邮箱密码，不是 OpenRouter 密码）
   - 收件箱 INBOX，取最新一封；正文保存至流程变量 orCodeRaw

⑦ 执行JS脚本 —— 填验证码（贴“片段2”）
   - 注入变量：把 orCodeRaw 注入，命名为 orCode（脚本读 orCode，会自动抽 6 位数字）
   - 返回值保存至：codeR

⑧ 等待时间 5000

⑨ 访问网站：网址 https://openrouter.ai/settings/credits ；等待 6000

⑩ 执行JS脚本 —— 打开加卡弹窗（贴“片段3”）

⑪ 等待时间 2500

⑫～⑮ 输入内容 ×4 —— 填卡（用元素“点选器”选 Stripe iframe 里的输入框最稳）
   - ⑫ 卡号：内容=16位卡号（纯数字）；有输入间隔就设 80
   - ⑬ 有效期：内容=MMYY（如 0431）
   - ⑭ 安全码：内容=CVC
   - ⑮ 邮编：内容=ZIP

⑯ 点击元素 —— 点选「Save payment method」按钮

⑰ 等待时间 4000

> 卡号/CVC 在 js.stripe.com 的 iframe 里，别用“执行JS脚本”填（跨域读不到）；
> 用「输入内容」节点 + 元素点选器（在浏览器里直接点那个框，AdsPower 记下含 iframe 的正确路径）。

---

# 详细 JS 与选择器

> 说明：AdsPower「执行JS脚本」节点的 JS 跑在**主页面上下文**。
> - ✅ 能做：登录表单(Clerk 在主页面)、填验证码、导航、点按钮、读 DOM
> - ❌ 不能：跨域读 Stripe iframe(卡号/CVC) → **加卡用「输入内容」节点**；验证码用「获取邮件」节点

整条流程节点顺序：
```
开始流程
 → 访问网址 https://openrouter.ai/sign-in (等 8000ms)
 → 执行JS脚本【片段1：填邮箱+密码】     注入变量: orEmail, orPassword
 → 等待时间 3000
 → 获取邮件【取 OpenRouter 验证码】      结果保存至: orCode
 → 执行JS脚本【片段2：填验证码】         注入变量: orCode
 → 等待元素出现 / 等待时间 5000
 → 访问网址 https://openrouter.ai/settings/credits (等 6000ms)
 → 执行JS脚本【片段3：打开加卡弹窗】
 → 等待时间 2500
 → 输入内容【卡号】   选择器见下(iframe)
 → 输入内容【有效期】 选择器见下
 → 输入内容【安全码】 选择器见下
 → 输入内容【邮编】
 → 点击元素【Save payment method】
```

---

## 片段1（增强版）：执行JS脚本 —— 填邮箱 + 密码（注入变量 orEmail / orPassword）

要点：宽选择器应对 Clerk 改版；React 受控输入用原生 setter + focus/blur 触发；Continue 禁用时改按回车；
轮询等密码框出现（Clerk 是同页两步，不换 URL）；最后返回明确状态。

```js
(async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const vis = (e) => e && e.offsetParent !== null && !e.disabled;

  // React 受控输入：必须用原生 value setter + input/change，并 focus/blur，Clerk 才认。
  const setVal = (el, val) => {
    el.focus();
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  };
  const waitSel = async (sels, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      for (const s of sels) { const e = document.querySelector(s); if (vis(e)) return e; }
      await sleep(300);
    }
    return null;
  };
  // 点 Continue/Sign in：优先文案按钮(未禁用)，否则在输入框按回车提交。
  const submit = async (field) => {
    const btn = [...document.querySelectorAll('button,[role="button"]')]
      .find((b) => vis(b) && /^(continue|sign in|log in|next)$/i.test((b.innerText || '').trim()));
    if (btn) { btn.click(); return; }
    if (field) { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true })); field.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true })); }
  };

  const EMAIL = ['#identifier-field', 'input[name="identifier"]', 'input[type="email"]', 'input[autocomplete="username"]'];
  const PWD = ['#password-field', 'input[name="password"]', 'input[type="password"]'];

  // 账号来源：优先流程变量 orEmail/orPassword；否则用系统变量 user_name/password(来自环境「账号平台」)。
  const email = (typeof orEmail !== 'undefined' && orEmail) ? orEmail
    : ((typeof user_name !== 'undefined' && user_name) ? user_name : '');
  const pwd = (typeof orPassword !== 'undefined' && orPassword) ? orPassword
    : ((typeof password !== 'undefined' && password) ? password : '');
  if (!email || !pwd) return 'NO_CREDENTIALS(注入变量未绑定/账号平台未填)';

  // 1) 邮箱
  const f = await waitSel(EMAIL, 20000);
  if (!f) return 'NO_EMAIL_FIELD';
  setVal(f, email); await sleep(800);
  await submit(f); await sleep(800);

  // 2) 密码框出现（同页两步，最多等 ~20s；若邮箱+密码同框则直接找到）
  const p = await waitSel(PWD, 20000);
  if (!p) {
    // 也许已直接登录或弹了人机验证
    if (/factor-two|verify/.test(location.href)) return 'NEED_CODE';
    if (!/sign-in|sign-up/.test(location.pathname)) return 'LOGGED_IN';
    return 'NO_PASSWORD_FIELD';
  }
  setVal(p, pwd); await sleep(800);
  await submit(p);

  // 3) 轮询结果(最多 ~30s)：到验证码步 / 已登录 / 账号错 / 人机验证
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const t = (document.body.innerText || '').toLowerCase();
    if (/couldn'?t find|no account|isn'?t right|incorrect|enter a correct/.test(t)) return 'NO_ACCOUNT_OR_BAD_PWD';
    if (/account is locked|too many|not allowed|not permitted/.test(t)) return 'ACCOUNT_BLOCKED';
    if (/factor-two|verify/.test(location.href)) return 'NEED_CODE';          // → 接「获取邮件」+片段2
    if (!/sign-in|sign-up/.test(location.pathname)) return 'LOGGED_IN';       // 直接登录成功(无需验证码)
  }
  return 'TIMEOUT_MAYBE_CAPTCHA'; // 30s 没推进：多半弹了 Turnstile/人机(AdsPower 干净指纹通常会被动过，可加「等待时间」后再判)
})();
```

**返回值用法**（节点「返回值保存至」设为变量，如 `loginR`，再用「条件判断」分支）：
- `NEED_CODE` → 接「获取邮件」取码 → 片段2
- `LOGGED_IN` → 直接跳到加卡(访问 /settings/credits)
- `NO_ACCOUNT_OR_BAD_PWD` / `ACCOUNT_BLOCKED` → 该号作废
- `TIMEOUT_MAYBE_CAPTCHA` → 加个「等待时间 8000」再跑一遍片段1的轮询，或人工

**登录页若弹 Turnstile**：AdsPower 干净指纹通常被动过；过不去就在片段1后加「等待元素消失(turnstile iframe)」或人工。

## 取码（推荐用你自己的 API，替代 IMAP 获取邮件节点）

接口 `POST https://firstmail.nexoraivision.com/api/messages/latest`，body `{email,password,folder:"INBOX"}`（密钥在你服务器端）。
无 CORS → 两种用法：
- A. 后端加 CORS(Allow-Origin:* / Methods:POST,OPTIONS) → 直接在 OpenRouter 页用**全 URL** fetch，一个节点取码+填码。
- B. 不改后端 → 新建标签页访问 messages.html(**同源**)，在该页跑下面脚本(相对路径 `/api`)，返回码存 `orCode`，切回 OpenRouter 填。

```js
(async function () {
  const email = (typeof user_name !== 'undefined' && user_name) ? user_name : (typeof orEmail !== 'undefined' ? orEmail : '');
  const pwd = (typeof password !== 'undefined' && password) ? password : (typeof orPassword !== 'undefined' ? orPassword : '');
  if (!email || !pwd) return 'NO_CREDENTIALS';
  const API = '/api/messages/latest'; // 同源用相对路径；OpenRouter页+CORS则用 https://firstmail.nexoraivision.com/api/messages/latest
  for (let i = 0; i < 12; i++) {
    try {
      const r = await fetch(API, { method: 'POST', headers: { 'accept': 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pwd, folder: 'INBOX' }) });
      const data = await r.json();
      const t = JSON.stringify(data || {});
      const m = t.match(/(?:code|verification|otp)[^0-9]{0,20}(\d{6})/i) || t.match(/\b(\d{6})\b/);
      if (m) return m[1];
    } catch (e) {}
    await new Promise((s) => setTimeout(s, 3000));
  }
  return 'NO_CODE';
})();
```

## 片段2：执行JS脚本 —— 填邮箱验证码（注入变量 orCode）

```js
(async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const setVal = (el, val) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  // orCode 可能是整封邮件文本，这里兜底抽取 6 位数字
  let raw = (typeof orCode !== 'undefined') ? String(orCode) : '';
  const m = raw.match(/\b(\d{6})\b/);
  const code = (m ? m[1] : raw.replace(/\D/g, '')).slice(0, 6);
  if (code.length < 4) return 'NO_CODE';

  const boxes = [...document.querySelectorAll('input[inputmode="numeric"],input[autocomplete="one-time-code"],input[name="code"],input[id*="code" i]')].filter((e) => e.offsetParent !== null);
  if (boxes.length >= code.length) {            // 多框：每位一个 input
    for (let i = 0; i < code.length; i++) { boxes[i].focus(); setVal(boxes[i], code[i]); await sleep(120); }
  } else if (boxes.length >= 1) {               // 单框
    boxes[0].focus(); setVal(boxes[0], code);
  } else { return 'NO_CODE_FIELD'; }
  await sleep(900);
  const b = [...document.querySelectorAll('button')].find((x) => /continue|verify|submit/i.test(x.innerText || ''));
  if (b) b.click();
  return 'CODE_ENTERED';
})();
```

## 片段3：执行JS脚本 —— 打开加卡弹窗（在 /settings/credits 页）

```js
(async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 先关掉可能挡住的 Account/Profile 弹窗
  document.querySelectorAll('[role="dialog"]').forEach((d) => {
    if (/Profile details|Manage your account/i.test(d.innerText || '')) {
      const x = [...d.querySelectorAll('button')].find((b) => b.querySelector('svg') && !(b.innerText || '').trim());
      if (x) x.click();
    }
  });
  await sleep(800);
  // 点「Add a Payment Method」(不要点 Add Credits)
  const b = [...document.querySelectorAll('button')].find((x) => /add a payment method/i.test(x.innerText || ''));
  if (b) { b.click(); return 'OPENED'; }
  return 'NO_ADD_PAYMENT_BTN';
})();
```

---

## 加卡字段 —— 用 AdsPower「输入内容」节点（JS 进不去 Stripe iframe）

在「输入内容」节点里用**元素选择器**选 Stripe iframe 内的输入框（AdsPower 选择器能穿透 iframe）。常见 selector：

| 字段 | 选择器(任选其一可命中) |
|---|---|
| 卡号 | `input[name="number"]` 或 `input[autocomplete="cc-number"]` |
| 有效期 | `input[name="expiry"]` 或 `input[autocomplete="cc-exp"]`（填 `MMYY`，如 `0431`） |
| 安全码 | `input[name="cvc"]` 或 `input[autocomplete="cc-csc"]` |
| 邮编 | `input[name="postalCode"]` 或 `input[autocomplete="postal-code"]` |
| 国家 | `select[name="country"]`（选 United States，通常已默认） |

> 提示：在「输入内容」节点里**逐字符输入**(若有"输入间隔"选项设 50~120ms)，避免太快被 Stripe 清空。
> Save：用「点击元素」节点，选文案含 `Save payment method` 的按钮。
> hCaptcha：AdsPower 指纹干净时通常**被动通过，不用管**；若弹九宫格，加「等待元素消失」或人工。
