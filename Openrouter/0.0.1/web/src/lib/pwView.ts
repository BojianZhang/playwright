import type { PwOverride } from './types';

// 入参只取密码相关三字段 → 成功行(AccountRow)与失败行(FailedRecord,email 可空)都能传。
export interface PwRow { password?: string; originalPassword?: string; passwordChanged?: boolean }

// 四列密码取值(改密覆盖账本优先,否则从结果行推导)——结果页四列、复制按钮、自定义导出、运行详情共用同一口径。
//  邮箱原密码 = originalPassword(accounts.txt 第二列);邮箱现密码 = 改密? op_pw : 原(全流程 changepw 把邮箱改成统一密码);
//  OpenRouter 原/现 = password(=op_pw,全流程不改 OR 密码 → 原=现,直到改密功能改它)。
//  改密成功后由 pw-changes 账本滚动覆盖(新值=现,改前值降级=原)。
export function pwView(a: PwRow, ov?: PwOverride) {
  const mbOrig = ov?.mailbox?.original ?? (a.originalPassword || '');
  const mbCur = ov?.mailbox?.current ?? (a.passwordChanged ? (a.password || a.originalPassword || '') : (a.originalPassword || ''));
  const orOrig = ov?.openrouter?.original ?? (a.password || '');
  const orCur = ov?.openrouter?.current ?? (a.password || '');
  return { mbOrig, mbCur, orOrig, orCur };
}
