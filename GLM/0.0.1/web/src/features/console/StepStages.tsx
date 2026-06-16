// 向导第 3 步:环节策略。主体 = 执行流程开关(选什么=跑什么);
// 有业务参数的环节(取Key/加卡/充值)给一张紧凑卡:当前激活预设 + 折叠就地编辑 + 跳「环节策略」页管理(同引擎配置解耦范式);
// 无参数环节(注册/绑地址/改密)只给一行说明卡,不再混成大策略卡。
// 执行流程引擎感知:Python 引擎(selenium/hybrid/split)无独立「绑地址」步(随加卡一起进行),故不渲染该 chip,
//   避免"勾了绑地址却空跑"——让"选什么 = 跑什么"在每个引擎下都成立。
import { Link } from 'react-router-dom';
import { Icon } from '../../lib/icons';
import { useConsole } from './ConsoleStateContext';
import { useStrategies } from './useStrategies';
import { Arrow, Chip } from './shared';
import StrategyEditor from './StrategyEditor';
import type { PresetStage } from '../../lib/strategySchema';

// 有业务参数的环节:当前激活预设名 + 「管理 / 多预设」链接 + 折叠就地编辑(照 StepEngine 的 EngineConfig 小节)。
function StrategyStageCard({ idx, stage, title, hint }: { idx: string; stage: PresetStage; title: string; hint?: string }) {
  const c = useConsole();
  const { data } = useStrategies();
  const st = data?.stages?.[stage];
  const activeName = st?.presets.find((p) => p.id === st.activeId)?.name;
  return (
    <>
      <div className="section-gap" />
      <section className="card">
        <div className="eb-top">
          <span className="idx c-green">{idx}</span><h3>{title}</h3>{hint && <span className="head-hint">{hint}</span>}
          <Link to="/strategies" className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }}><Icon name="external" size={12} />管理 / 多预设</Link>
        </div>
        <details className="adv">
          <summary>展开编辑当前策略<span className="adv-hint">当前预设「{activeName || '…'}」 · 切预设 / 改参数 / 保存</span></summary>
          <div style={{ padding: '4px 18px 16px' }}>
            <StrategyEditor stage={stage} engine={c.engine} />
          </div>
        </details>
      </section>
    </>
  );
}

// 无业务参数的环节:一行说明卡(收敛展示,不再和有参数环节一样占大块)。
function NoteCard({ idx, title, hint, children }: { idx: string; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <>
      <div className="section-gap" />
      <section className="card">
        <div className="eb-top"><span className="idx c-green">{idx}</span><h3>{title}</h3>{hint && <span className="head-hint">{hint}</span>}</div>
        <div style={{ padding: '10px 18px 14px' }}><p className="help" style={{ margin: 0 }}>{children}</p></div>
      </section>
    </>
  );
}

export default function StepStages() {
  const c = useConsole();
  const { stages } = c;
  // 混合/分流流水线打包跑「注册→取Key→绑地址→加卡」,取Key/加卡不可单独关 → 锁定显示;改密现已支持(绑成后改邮箱密码)。
  const lockKeyCard = c.engine === 'hybrid' || c.engine === 'split';
  return (
    <>
      {/* 执行流程 */}
      <section className="card pipeline-band">
        <div className="pb-head">
          <span className="pb-icon"><Icon name="activity" size={14} /></span>
          <h3>执行流程</h3>
          <span className="pb-sub">点格子开/关该步 · 勾后面的会自动勾上它需要的前置、取消前面的会取消后面的 · 仅 <b>充值</b> 真扣钱 · <b>选什么就跑什么</b>;各环节参数在下方卡内折叠编辑或去<Link to="/strategies" style={{ color: 'var(--primary-text)' }}>环节策略</Link>页统一管理</span>
        </div>
        <div className="pipeline">
          <div className="stage locked on"><span className="schk"><Icon name="check" size={10} /></span>注册 / 登录</div>
          <Arrow />
          {lockKeyCard
            ? <Chip on locked title="混合 / 分流引擎为打包全流程,取 API 密钥必跑、不可单独关">取 API 密钥</Chip>
            : <Chip on={stages.key} onClick={() => c.clickChip('key')}>取 API 密钥</Chip>}
          <Arrow />
          {/* Python 引擎无独立绑地址步(随加卡进行),不渲染该 chip */}
          {!c.isPython && (
            <>
              <Chip on={stages.addr} onClick={() => c.clickChip('addr')}>绑地址</Chip>
              <Arrow />
            </>
          )}
          {lockKeyCard
            ? <Chip on locked title="混合 / 分流引擎为打包全流程,加卡(含绑地址)必跑、不可单独关">加卡<em>含绑地址</em></Chip>
            : <Chip on={stages.card} onClick={() => c.clickChip('card')}>加卡{c.isPython && <em>含绑地址</em>}</Chip>}
          <Arrow />
          <Chip on={stages.charge} charge onClick={() => c.clickChip('charge')}>充值 <em>扣钱</em></Chip>
          <Arrow />
          <Chip on={stages.pwd} onClick={() => c.clickChip('pwd')} dim={!c.unifiedPwd.trim()} title={c.unifiedPwd.trim() ? '改密(点一下会自动点亮所需前置)' : '改密需先填上方「统一密码」'}>改密</Chip>
        </div>
      </section>

      {/* ① 注册 / 登录(恒在) */}
      <NoteCard idx="①" title="注册 / 登录" hint="每个账号都会跑">
        本环节无独立业务参数。注册的「验证码转人工」等属于<b>引擎怎么跑</b>,在<Link to="/engine-config" style={{ color: 'var(--primary-text)' }}>引擎配置</Link>(Playwright)里设。
      </NoteCard>

      {/* ② 取 API 密钥 */}
      {stages.key && <StrategyStageCard idx="②" stage="key" title="取 API 密钥" hint="注册后创建一个 API Key" />}

      {/* ③ 绑地址(仅 Playwright 作为独立步;Python 随加卡进行) */}
      {stages.addr && !c.isPython && (
        <NoteCard idx="③" title="绑地址" hint="给账号绑定账单地址">
          本环节无独立参数。地址来源:在「数据」步的<b>账单地址</b>框填了就<b>从池里取</b>,留空则<b>自动生成随机地址</b>。
        </NoteCard>
      )}

      {/* ④ 加卡(Python 含绑地址) */}
      {stages.card && <StrategyStageCard idx="④" stage="card" title={c.isPython ? '加卡(含绑地址)' : '加卡'} hint="绑定支付卡(过 Stripe)" />}

      {/* ⑤ 充值 */}
      {stages.charge && <StrategyStageCard idx="⑤" stage="charge" title="充值(真扣钱)" hint="给账号余额充值" />}

      {/* ⑥ 改密 */}
      {stages.pwd && (
        <NoteCard idx="⑥" title="改密" hint="把邮箱密码改成统一密码">
          本环节无独立参数。新密码用「全局设置」里的<b>统一密码</b>(<code>{c.unifiedPwd.trim() || '未填'}</code>)。{c.pwdGateOk ? '' : (c.isPython ? ' 需启用 取Key 且统一密码非空,否则本步不会执行。' : ' 需同时启用 取Key + 充值 且统一密码非空,否则本步不会执行。')}
          {(c.engine === 'hybrid' || c.engine === 'split') && <><br /><span style={{ color: 'var(--text-3)' }}>混合 / 分流:绑卡成功后改邮箱密码为统一密码(改密是最后一步,失败号不改、留续跑)。</span></>}
        </NoteCard>
      )}
    </>
  );
}
