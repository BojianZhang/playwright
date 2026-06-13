// 成功/失败回显模板编辑器(移植自旧 modals.js setupEcho):变量插入 / 分隔符 / 实时预览。
import { useEffect, useRef, useState } from 'react';
import { Modal } from '../components/Modal';
import { Icon } from '../lib/icons';

const SEP: Record<string, string> = { space: ' ', pipe: ' | ', colon: ':', comma: ',', nl: '\n' };

interface VarDef { k: string; label: string; desc: string; sample: string; }
const SUCCESS_VARS: VarDef[] = [
  { k: 'email', label: '邮箱', desc: '账号邮箱', sample: 'user1@firstmail.com' },
  { k: 'password', label: '密码', desc: '当前密码:设了统一密码并改密成功后＝新密码,否则＝原密码', sample: 'MyNewPass#2026' },
  { k: 'originalPassword', label: '原密码', desc: '邮箱原始密码(注册时用的)', sample: 'oldpw123' },
  { k: 'apiKey', label: 'key', desc: 'OpenRouter API Key', sample: 'sk-or-v1-abcd…ef01' },
  { k: 'billingStatus', label: 'billing', desc: 'skipped 未操作 / address-bound 已绑地址 / card-bound 已加卡 / success 已充值 / declined 被拒', sample: 'success' },
  { k: 'charged', label: '充值', desc: '实际充值金额(美元,未充值为 0)', sample: '10' },
  { k: 'cardLast4', label: 'card', desc: '本次所用卡号末 4 位', sample: '8695' },
  { k: 'passwordChanged', label: '改密', desc: '邮箱密码是否改为统一密码(true / false)', sample: 'true' },
  { k: 'exitIp', label: 'ip', desc: '代理出口 IP(该线路实际出网 IP)', sample: '203.0.113.7' },
];
const FAIL_VARS: VarDef[] = [
  { k: 'email', label: '邮箱', desc: '账号邮箱', sample: 'user2@firstmail.com' },
  { k: 'password', label: '密码', desc: '密码(失败时为原密码)', sample: 'oldpw456' },
  { k: 'reason', label: '原因', desc: '失败原因码(如 ACCOUNT_LOCKED、TURNSTILE_FAILED)', sample: 'ACCOUNT_LOCKED' },
  { k: 'stage', label: '阶段', desc: '失败发生的阶段', sample: 'signup' },
  { k: 'failClass', label: '分类', desc: '失败分类(便于统计归类)', sample: 'account' },
  { k: 'attempts', label: '尝试', desc: '实际尝试次数', sample: '3' },
  { k: 'detail', label: '详情', desc: '失败详情(最多 300 字)', sample: '账号在注册后被锁定' },
];

export function EchoModal({ kind, open, onClose, value, onSave }: {
  kind: 'success' | 'fail'; open: boolean; onClose: () => void; value: string; onSave: (v: string) => void;
}) {
  const vars = kind === 'success' ? SUCCESS_VARS : FAIL_VARS;
  const [tpl, setTpl] = useState(value);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // 每次打开时把编辑框同步成外部当前值(沿用旧 modals.js 的 _onOpen 行为)
  useEffect(() => { if (open) setTpl(value); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const preview = (() => { let out = tpl; vars.forEach((v) => { out = out.split('{{' + v.k + '}}').join(v.sample); }); return out; })();

  function insert(text: string) {
    const ta = taRef.current; if (!ta) { setTpl((t) => t + text); return; }
    const s = ta.selectionStart ?? tpl.length, e = ta.selectionEnd ?? tpl.length;
    const next = tpl.slice(0, s) + text + tpl.slice(e);
    setTpl(next);
    requestAnimationFrame(() => { ta.focus(); const pos = s + text.length; ta.setSelectionRange(pos, pos); });
  }

  return (
    <Modal open={open} onClose={onClose} size="md" icon="check" iconKind={kind === 'success' ? 'ok' : 'fail'}
      title={<>{kind === 'success' ? '成功' : '失败'}回显 <span className="dim">— 可用变量 / 编辑格式</span></>}
      foot={<>
        <button className="btn btn-ghost" onClick={() => setTpl('')}><Icon name="trash" size={14} /> 清空格式</button>
        <div className="spacer" />
        <button className="btn btn-primary" onClick={() => { onSave(tpl); onClose(); }}>完成</button>
      </>}>
      <div className="modal-body">
        <p className="modal-intro">把变量写进下面的格式里,运行结束时会自动替换成真实值。点变量右侧「插入」可加到光标处;下方是示例数据的实时预览。</p>
        <div className="m-field">
          <div className="m-label">输出格式</div>
          <textarea ref={taRef} className="m-tpl" spellCheck={false} value={tpl} onChange={(e) => setTpl(e.target.value)} />
        </div>
        <div className="m-field">
          <div className="m-label">实时预览 <span className="dim">(示例数据)</span></div>
          <div className="m-preview">{preview ? preview : <span className="ph">(格式为空)</span>}</div>
        </div>
        <div className="m-field">
          <div className="m-label">分隔符 <span className="dim">(点击插入到光标处)</span></div>
          <div className="sep-row">
            {Object.keys(SEP).map((s) => <button key={s} className="sep-btn" onClick={() => insert(SEP[s])}>{({ space: '空格', pipe: '|', colon: ':', comma: ',', nl: '换行' } as Record<string, string>)[s]}</button>)}
          </div>
        </div>
        <div className="m-field">
          <div className="m-label">可用变量及含义 <span className="dim">(「插入」=只插变量;「带名」=简称变量)</span></div>
          <div>
            {vars.map((v) => (
              <div className="vrow" key={v.k}>
                <div className="vname"><span className="vvar">{`{{${v.k}}}`}</span><span className="vlabel">{v.label}</span></div>
                <div className="vdesc">{v.desc}</div>
                <button className="btn btn-soft btn-sm" onClick={() => insert(`{{${v.k}}}`)}>插入</button>
                <button className="btn btn-ghost btn-sm" onClick={() => insert(`${v.label}:{{${v.k}}}`)}>带名</button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
