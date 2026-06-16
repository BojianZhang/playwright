// 引擎配置页:4 个引擎各一块独立配置(可多套命名预设),各记各的。
// 边界:这里只管"该引擎怎么跑"的技术行为;各环节业务参数在「控制台 → 环节策略」,与引擎无关的全局也在控制台。
// 控制台只「选引擎 + 引用其激活配置」,不在向导里编辑这些字段(解耦)。
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../lib/icons';
import { ENGINE_LIST, ENGINE_SUBTITLE, ENGINE_FIELDS, type EngineKey } from '../lib/engineSchema';
import { useEngineConfigs } from '../features/console/useEngineConfigs';
import EngineConfigEditor from '../features/console/EngineConfigEditor';

export default function EngineConfigPage() {
  const [engine, setEngine] = useState<EngineKey>('playwright');
  const { data, isLoading, isError } = useEngineConfigs();
  const en = data?.engines?.[engine];
  const presetCount = en?.presets.length ?? 0;
  const activeName = en?.presets.find((p) => p.id === en.activeId)?.name;

  return (
    <main className="page">
      <div className="page-head">
        <h1>引擎配置 · 管理中心</h1>
        <p>一屏管理<b>全部引擎</b>的配置与<b>多套命名预设</b>(新建 / 复制 / 重命名 / 切激活)。
          日常跑批时,<Link to="/console" style={{ color: 'var(--primary-text)' }}>控制台第 2 步</Link>可<b>就地展开编辑</b>当前引擎、无需来这;此页适合统一管理、多预设对比。
          这里只管<b>引擎怎么跑</b>(填卡 / 求解 / 换IP / 环境 / 分流);各环节业务参数(Key名 / 卡次数 / 金额)在控制台→环节策略,密码 / 并发等全局也在控制台。</p>
      </div>

      <div className="tabs tabs-settings">
        {ENGINE_LIST.map((e) => {
          const g = data?.engines?.[e.key];
          const n = g?.presets.length ?? 0;
          return (
            <button key={e.key} className={'tab' + (engine === e.key ? ' on' : '')} onClick={() => setEngine(e.key)}>
              <Icon name="cpu" size={13} />{e.label}{n > 1 && <span className="kbadge neutral" style={{ marginLeft: 6 }}>{n}</span>}
            </button>
          );
        })}
      </div>

      <section className="card">
        <div className="eb-top">
          <span className="idx c-info"><Icon name="cpu" size={12} /></span>
          <h3>{ENGINE_LIST.find((e) => e.key === engine)?.label} 配置</h3>
          <span className="head-hint">{ENGINE_SUBTITLE[engine]}</span>
        </div>
        <div style={{ padding: '4px 18px 18px' }}>
          {isError ? (
            <div className="empty-note" style={{ borderColor: 'var(--danger-bd)', background: 'var(--danger-weak)', color: 'var(--text-1)', textAlign: 'left', lineHeight: 1.7 }}>
              <b style={{ color: 'var(--danger)' }}>加载引擎配置失败</b> —— 后端缺少 <code>/api/engine-configs</code> 接口。
              这通常是<b>后端未重启</b>:前端已更新,但运行中的 <code>node server.js</code> 还是旧进程。
              <br />请<b>停止并重新运行 <code>node server.js</code></b>(或 <code>node web/server.js</code>),然后刷新本页。
            </div>
          ) : (!data || !en) ? (
            <div className="empty-note">{isLoading ? '加载中…' : '无数据。请重启后端 node server.js 后刷新。'}</div>
          ) : (
            <>
              <div style={{ marginBottom: 10, fontSize: 12, color: 'var(--text-3)' }}>
                共 <b style={{ color: 'var(--text-1)' }}>{presetCount}</b> 套预设 · 当前激活:<b style={{ color: 'var(--success)' }}>{activeName || '…'}</b> ·
                含 <b style={{ color: 'var(--text-1)' }}>{ENGINE_FIELDS[engine].length}</b> 项可调参数
              </div>
              <EngineConfigEditor engine={engine} />
            </>
          )}
        </div>
      </section>
    </main>
  );
}
