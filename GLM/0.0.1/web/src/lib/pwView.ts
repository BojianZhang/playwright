// 四列密码取值(纯推导)——GLM 无改密覆盖账本,只从结果行推导;结果页四列、复制按钮、自定义导出、运行详情共用。
//  邮箱原密码 = originalPassword(accounts.txt 第二列);邮箱现密码 = 改密? op_pw : 原(全流程 changepw 把邮箱改成统一密码);
//  z.ai 原/现 = password(=op_pw=z.ai 登录密码,全流程不改 z.ai 密码 → 原=现)。
//  字段名沿用 mbOrig/mbCur/orOrig/orCur(与 Openrouter 版结构一致,便于后续去重);其中 orOrig/orCur 在 GLM = z.ai 登录密码。
export interface PwRow { password?: string; originalPassword?: string; passwordChanged?: boolean }

export function pwView(a: PwRow) {
  const mbOrig = a.originalPassword || '';
  const mbCur = a.passwordChanged ? (a.password || a.originalPassword || '') : (a.originalPassword || '');
  const orOrig = a.password || '';
  const orCur = a.password || '';
  return { mbOrig, mbCur, orOrig, orCur };
}
