// 环节策略页:各环节(取Key / 加卡 / 充值)一块独立配置(可多套命名预设),各记各的。
// 边界:这里只管各环节"做什么"的业务参数(Key名/有效期、每卡次数/试卡数、充值金额);
//   "该引擎怎么跑"的技术行为在「引擎配置」,跑哪些环节(执行流程)在控制台。
// 控制台只「选流程 + 引用激活预设」,与引擎配置解耦同范式。
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../lib/icons';
import { STRATEGY_STAGES, STAGE_TITLE, STRATEGY_SCHEMA, type PresetStage } from '../lib/strategySchema';
import { useStrategies } from '../features/console/useStrategies';
import StrategyEditor from '../features/console/StrategyEditor';

// 页面里按字段全集(playwright)编辑;过滤出在 playwright 下可见的字段用于计数。
const fieldCount = (stage: PresetStage) =>
  STRATEGY_SCHEMA[stage].filter((f) => !f.engines || f.engines.includes('playwright')).length;

export default function StrategiesPage() {
  const [stage, setStage] = useState<PresetStage>('key');
  const { data, isLoading, isError } = useStrategies();
  const st = data?.stages?.[stage];
  const presetCount = st?.presets.length ?? 0;
  const activeName = st?.presets.find((p) => p.id === st.activeId)?.name;

  return (
    <main className="page">
      <div className="page-head">
        <h1>环节策略</h1>
        <p>每个环节<b>各存各的策略</b>(可多套命名预设、一键切换激活)。这里只管各环节的<b>业务参数</b>(Key 名称 / 有效期、每卡次数 / 试卡数、充值金额);
          <b>该引擎怎么跑</b>(填卡 / 求解 / 换IP / 环境 / 分流)在<Link to="/engine-config" style={{ color: 'var(--primary-text)' }}>引擎配置</Link>,
          <b>跑哪些环节</b>(执行流程)在<Link to="/console" style={{ color: 'var(--primary-text)' }}>控制台</Link>。控制台只「选流程 + 引用激活预设」。</p>
      </div>

      <div className="tabs tabs-settings">
        {STRATEGY_STAGES.map((s) => {
          const g = data?.stages?.[s];
          const n = g?.presets.length ?? 0;
          return (
            <button key={s} className={'tab' + (stage === s ? ' on' : '')} onClick={() => setStage(s)}>
              <Icon name="activity" size={13} />{STAGE_TITLE[s]}{n > 1 && <span className="kbadge neutral" style={{ marginLeft: 6 }}>{n}</span>}
            </button>
          );
        })}
      </div>

      <section className="card">
        <div className="eb-top">
          <span className="idx c-green"><Icon name="activity" size={12} /></span>
          <h3>{STAGE_TITLE[stage]} 策略</h3>
          <span className="head-hint">该环节的业务参数(可多套预设)</span>
        </div>
        <div style={{ padding: '4px 18px 18px' }}>
          {isError ? (
            <div className="empty-note" style={{ borderColor: 'var(--danger-bd)', background: 'var(--danger-weak)', color: 'var(--text-1)', textAlign: 'left', lineHeight: 1.7 }}>
              <b style={{ color: 'var(--danger)' }}>加载环节策略失败</b> —— 后端缺少 <code>/api/strategies</code> 接口。
              这通常是<b>后端未重启</b>:前端已更新,但运行中的 <code>node server.js</code> 还是旧进程。
              <br />请<b>停止并重新运行 <code>node server.js</code></b>(或 <code>node web/server.js</code>),然后刷新本页。
            </div>
          ) : (!data || !st) ? (
            <div className="empty-note">{isLoading ? '加载中…' : '无数据。请重启后端 node server.js 后刷新。'}</div>
          ) : (
            <>
              <div style={{ marginBottom: 10, fontSize: 12, color: 'var(--text-3)' }}>
                共 <b style={{ color: 'var(--text-1)' }}>{presetCount}</b> 套预设 · 当前激活:<b style={{ color: 'var(--success)' }}>{activeName || '…'}</b> ·
                含 <b style={{ color: 'var(--text-1)' }}>{fieldCount(stage)}</b> 项可调参数
              </div>
              <StrategyEditor stage={stage} engine="playwright" />
              <p className="help" style={{ margin: '12px 0 0' }}>注:个别参数仅对部分引擎下发(如<b>最多试卡数</b>仅 Playwright);Python 引擎只用<b>每卡次数</b>与<b>充值金额</b>。</p>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
