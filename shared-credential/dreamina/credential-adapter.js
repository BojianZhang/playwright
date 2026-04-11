'use strict';

/**
 * credential-adapter.js
 *
 * 这个文件是 Dreamina 在阶段 2（credential submit）里的站点适配层。
 *
 * 它负责：
 * - Dreamina credential form ready 判断
 * - Dreamina email / password 填写
 * - Dreamina Continue / Submit 点击
 * - Dreamina 提交结果确认
 * - Dreamina 阶段 2 失败分类
 *
 * 它不负责：
 * - 首页打开
 * - 登录入口切换
 * - 验证码阶段
 * - birthday / profile completion
 * - session / storage
 */

/**
 * 等待 Dreamina credential form ready。
 *
 * 作用：
 * - 确认 email input / password input / submit button 是否已经可用
 * - 第一版先保留骨架
 */
async function waitForDreaminaCredentialFormReady(page, runtime = {}, context = {}) {
  return {
    ok: false,
    state: 'FORM_READY_NOT_IMPLEMENTED',
  };
}

/**
 * 填写 Dreamina email。
 *
 * 作用：
 * - 负责阶段 2 的 email 输入动作
 */
async function fillDreaminaCredentialEmail(page, account, runtime = {}, context = {}) {
  return {
    ok: false,
    state: 'EMAIL_FILL_NOT_IMPLEMENTED',
    account: account?.email || '',
  };
}

/**
 * 填写 Dreamina password。
 *
 * 作用：
 * - 负责阶段 2 的 password 输入动作
 */
async function fillDreaminaCredentialPassword(page, account, runtime = {}, context = {}) {
  return {
    ok: false,
    state: 'PASSWORD_FILL_NOT_IMPLEMENTED',
  };
}

/**
 * 提交 Dreamina credential form。
 *
 * 作用：
 * - 点击 Continue / Submit
 */
async function submitDreaminaCredentialForm(page, runtime = {}, context = {}) {
  return {
    ok: false,
    state: 'FORM_SUBMIT_NOT_IMPLEMENTED',
  };
}

/**
 * 确认 Dreamina credential submit 结果。
 *
 * 作用：
 * - 判断是否进入验证码阶段
 * - 判断是否出现 existing account / rejected / rate limited / inline error
 */
async function confirmDreaminaCredentialSubmitResult(page, runtime = {}, context = {}) {
  return {
    ok: false,
    state: 'SUBMIT_RESULT_NOT_IMPLEMENTED',
    nextStage: '',
  };
}

/**
 * 对 Dreamina 阶段 2 失败做分类。
 *
 * 作用：
 * - 将阶段 2 的失败 reason 收敛成 Dreamina 专属语义
 */
function classifyDreaminaCredentialSubmitFailure(input = {}) {
  return {
    reason: String(input.reason || 'UNKNOWN'),
    siteReason: String(input.reason || 'UNKNOWN'),
    hardFailure: false,
  };
}

module.exports = {
  waitForDreaminaCredentialFormReady,
  fillDreaminaCredentialEmail,
  fillDreaminaCredentialPassword,
  submitDreaminaCredentialForm,
  confirmDreaminaCredentialSubmitResult,
  classifyDreaminaCredentialSubmitFailure,
};
