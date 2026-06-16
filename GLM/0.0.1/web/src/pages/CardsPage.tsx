// 卡池(资源页):报表区(KPI + 状态分布环图)+ 管理表(复用 PoolTab)。
// 边界:只管支付卡(加卡阶段刷的卡),不管账号/代理/地址。
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import { parseKind } from '../lib/parse';
import { Icon } from '../lib/icons';
import type { CardsResp, CardRow } from '../lib/types';
import { Kpi } from '../components/Kpi';
import { Donut, DrillableChart, type Seg, type DrillCol } from '../components/charts';
import { ImportModal } from '../components/ImportModal';
import { PoolTab } from '../features/panels';

export default function CardsPage() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['cards'], queryFn: () => apiGet<CardsResp>('/api/cards', true), refetchInterval: 20000 });   // 有界卡池,8s→20s
  const cards = data?.cards || [];
  const [impOpen, setImpOpen] = useState(false);
  const [maxUses, setMaxUses] = useState(10);
  const by = (s: string) => cards.filter((c) => c.status === s).length;
  const okSum = cards.reduce((n, c) => n + (c.successCount || 0), 0);
  const declSum = cards.reduce((n, c) => n + (c.declineCount || 0), 0);
  // 充值容量读数:总金额 + 按 $5 参考充值额「还能真充几次」(填了次数按次数 / 填了金额按金额 / 未跟踪按绑定数)
  const CAP_AMT = 5;
  const totalBalance = data?.totalBalance ?? cards.reduce((n, c) => n + (c.balance || 0), 0);
  const fundable = cards.filter((c) => c.status === 'active').reduce((n, c) => {
    const bindLeft = Math.max(0, (c.maxUses || 1) - (c.usedCount || 0));
    const cap = (c.chargeCap || 0) > 0 ? (c.chargeCap || 0) : ((c.balance || 0) > 0 ? Math.floor((c.balance || 0) / CAP_AMT) : Infinity);
    const chargeLeft = cap === Infinity ? bindLeft : Math.max(0, cap - (c.chargedTotal || 0));
    return n + Math.min(bindLeft, chargeLeft);
  }, 0);
  const tracked = cards.some((c) => (c.chargeCap || 0) > 0 || (c.balance || 0) > 0);
  const segs: Seg[] = [
    { label: '可用', value: by('active'), colorVar: '--success' },
    { label: '用尽', value: by('exhausted'), colorVar: '--warn' },
    { label: '被拒', value: by('declined'), colorVar: '--danger' },
    { label: '禁用', value: by('disabled'), colorVar: '--text-4' },
  ];
  const SEG_STATUS = ['active', 'exhausted', 'declined', 'disabled'];
  const cardDrillCols: DrillCol<CardRow>[] = [
    { label: '卡末4', className: 'mono', render: (c) => c.masked },
    { label: '有效期', className: 'mono', render: (c) => c.exp },
    { label: '已用/上限', className: 'mono', align: 'right', render: (c) => `${c.usedCount} / ${c.maxUses}` },
    { label: '成功/被拒', className: 'mono', align: 'right', render: (c) => `${c.successCount || 0} / ${c.declineCount || 0}` },
  ];

  return (
    <main className="page">
      <div className="page-head"><h1>卡池</h1><p>支付卡管理 —— 加卡阶段刷的卡。<b>只管卡</b>(不管账号 / 代理 / 地址)。</p></div>

      <div className="grid-2">
        <div className="kpi-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <Kpi icon="card" label="总卡数" value={cards.length} sub={`可用 ${by('active')}`} />
          <Kpi icon="okcircle" label="累计成功" value={okSum} tone="ok" sub={`被拒 ${declSum}`} />
          <Kpi icon="alert" label="用尽 / 禁用" value={`${by('exhausted')} / ${by('disabled')}`} tone="warn" />
          <Kpi icon="card" label="充值容量" value={tracked ? `可充 ${fundable}` : '未跟踪'} sub={tracked ? `总金额 $${totalBalance}(按 $${CAP_AMT} 估)` : '卡未填次数/金额'} />
        </div>
        <section className="card">
          <div className="card-head"><span className="idx c-green">▤</span><h3>卡状态分布</h3><span className="head-hint">点击查看明细</span></div>
          <div style={{ padding: '16px 18px' }}>{cards.length ? (
            <DrillableChart<CardRow>
              chart={(onSelect, active) => <Donut data={segs} centerValue={cards.length} centerLabel="总卡数" onSelect={onSelect} activeIndex={active} />}
              resolve={(i) => ({ title: <>卡状态 · {segs[i].label}</>, rows: cards.filter((c) => c.status === SEG_STATUS[i]), columns: cardDrillCols })}
              rowKey={(c) => c.id}
            />
          ) : <div className="empty-note">卡池为空。</div>}</div>
        </section>
      </div>

      <div className="section-gap" />

      <section className="card">
        <div className="eb-top"><span className="idx c-info">▥</span><h3>卡片明细</h3><span className="head-hint">导入 / 禁用 / 重置 / 删除 / 改可用次数</span>
          <button className="btn btn-soft btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setImpOpen(true)}><Icon name="upload" size={12} />导入卡池</button>
        </div>
        <div style={{ padding: '6px 4px 0' }}><PoolTab /></div>
      </section>

      <ImportModal open={impOpen} onClose={() => setImpOpen(false)} title="导入卡池" label="银行卡"
        hint={<>每行一卡,自动解析(卡号 + 有效期 MM/YY + CVC);或选文件上传</>}
        placeholder={'4111 1111 1111 1111  02/29  093\n4111111111111111|05/30|130'}
        parse={(t) => parseKind('card', t)}
        extra={<div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">每卡可用次数</span><span className="l-hint">导入的新卡 maxUses(刷几个号)</span></div>
          <input type="number" min={1} max={100} value={maxUses} onChange={(e) => setMaxUses(Math.max(1, Math.min(100, Math.floor(Number(e.target.value)) || 1)))} style={{ width: 120 }} /></div>}
        onImport={async (raw) => { const d = await apiPost('/api/cards/import', { cardsRaw: raw, maxUses }); qc.invalidateQueries({ queryKey: ['cards'] }); return d; }}
        formatResult={(r) => { const d = r as { added?: number; updated?: number; available?: number; parseErrors?: unknown[] }; return `新增 ${d.added || 0} · 更新 ${d.updated || 0} · 可用 ${d.available || 0}${(d.parseErrors || []).length ? ` · ${(d.parseErrors || []).length} 行无法解析` : ''}`; }} />
    </main>
  );
}
