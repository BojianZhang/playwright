// 失败恢复策略页:按【失败类型】配置自动重试时是否参与重跑(可多套命名预设、一键切换激活)。
// 边界:这里只配「自动重试(AUTO_RETRY)各失败类型是否重跑」;换卡张数/ZIP/hcaptcha 在「高级参数/引擎配置」(链接指过去,不重复造);
//   歧义态不重绑、号被拒/坏邮箱永久跳过 = 固定铁律,只读展示。需在「引擎配置/控制台」开启「自动重试失败号」此页才生效。
import { Link } from 'react-router-dom';
import { Icon } from '../lib/icons';
import { RECOVERY_ALL_FIELDS, RECOVERY_FIXED_RULES } from '../lib/recoverySchema';
import { useRecovery } from '../features/console/useRecovery';
import RecoveryEditor from '../features/console/RecoveryEditor';

const TONE_CLASS: Record<string, string> = { warn: 'warn', fail: 'fail', neutral: 'neutral' };

export default function RecoveryStrategiesPage() {
  const { data, isLoading, isError } = useRecovery();
  const grp = data?.recovery;
  const presetCount = grp?.presets.length ?? 0;
  const activeName = grp?.presets.find((p) => p.id === grp.activeId)?.name;

  return (
    <main className="page">
      <div className="page-head">
        <h1>失败恢复策略</h1>
        <p>一套<b>恢复方案</b> = <b>重试参与度</b>(各失败类型要不要重跑)+ <b>恢复动作</b>(换IP轮数 / ZIP重试 / 换卡策略 / 人机换卡)。
          可多套命名预设、一键切换激活。依赖运行结果里已归因好的<b>失败环节</b>(注册/取Key/加卡/充值)。
          <b>恢复动作</b>在<Link to="/runs" style={{ color: 'var(--primary-text)' }}>运行详情</Link>的「批量恢复」里按失败主因自动推荐对应方案;
          <b>重试参与度</b>需先在<Link to="/engine-config" style={{ color: 'var(--primary-text)' }}>引擎配置</Link>/<Link to="/console" style={{ color: 'var(--primary-text)' }}>控制台</Link>开启
          <b>「自动重试失败号」</b>才生效。</p>
      </div>

      <section className="card">
        <div className="eb-top">
          <span className="idx c-warn"><Icon name="refresh" size={12} /></span>
          <h3>各失败类型 · 自动重试参与度</h3>
          <span className="head-hint">默认全部参与(= 现状重试所有非永久失败)</span>
        </div>
        <div style={{ padding: '4px 18px 18px' }}>
          {isError ? (
            <div className="empty-note" style={{ borderColor: 'var(--danger-bd)', background: 'var(--danger-weak)', color: 'var(--text-1)', textAlign: 'left', lineHeight: 1.7 }}>
              <b style={{ color: 'var(--danger)' }}>加载恢复策略失败</b> —— 后端缺少 <code>/api/recovery</code> 接口。
              这通常是<b>后端未重启</b>:前端已更新,但运行中的 <code>node server.js</code> 还是旧进程。
              <br />请<b>停止并重新运行 <code>node server.js</code></b>,然后刷新本页。
            </div>
          ) : (!data || !grp) ? (
            <div className="empty-note">{isLoading ? '加载中…' : '无数据。请重启后端 node server.js 后刷新。'}</div>
          ) : (
            <>
              <div style={{ marginBottom: 10, fontSize: 12, color: 'var(--text-3)' }}>
                共 <b style={{ color: 'var(--text-1)' }}>{presetCount}</b> 套预设 · 当前激活:<b style={{ color: 'var(--success)' }}>{activeName || '…'}</b> ·
                含 <b style={{ color: 'var(--text-1)' }}>{RECOVERY_ALL_FIELDS.length}</b> 项可调参数(重试参与度 + 恢复动作)
              </div>
              <RecoveryEditor />
            </>
          )}
        </div>
      </section>

      <div className="section-gap" />

      <section className="card">
        <div className="eb-top">
          <span className="idx c-amber"><Icon name="alert" size={12} /></span>
          <h3>固定规则(不可配 · 安全铁律)</h3>
          <span className="head-hint">这些情形永远按固定策略处理,绝不暴露成「可重试」开关</span>
        </div>
        <div style={{ padding: '4px 18px 18px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {RECOVERY_FIXED_RULES.map((r) => (
              <div key={r.label} style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
                <span className={'kbadge ' + (TONE_CLASS[r.tone] || 'neutral')} style={{ flexShrink: 0, minWidth: 120, textAlign: 'center' }}>{r.label}</span>
                <span style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.6 }}>{r.detail}</span>
              </div>
            ))}
          </div>
          <p className="help" style={{ margin: '12px 0 0' }}>注:这些规则防的是<b>重复扣款 / 重复绑卡 / 浪费号源</b>(真金白银不可回滚),故不开放配置。</p>
        </div>
      </section>
    </main>
  );
}
