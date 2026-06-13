// 向导第 1 步:数据导入(账号/代理/卡池/账单地址)。代理/地址可切「从已保存的池选用」。
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { apiGet } from '../../lib/api';
import { Icon } from '../../lib/icons';
import type { ProxyRow, AddressRow } from '../../lib/types';
import { useConsole } from './ConsoleStateContext';
import { DataCol } from './shared';

function PoolToggle({ on, set, label }: { on: boolean; set: (v: boolean) => void; label: string }) {
  return (
    <label className="check" style={{ marginLeft: 'auto', fontSize: 11.5 }}>
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} /><span className="box"><Icon name="check" size={11} /></span>{label}
    </label>
  );
}

export default function StepData() {
  const c = useConsole();
  const { data: px } = useQuery({ queryKey: ['proxies'], queryFn: () => apiGet<{ items: ProxyRow[] }>('/api/proxies', true), enabled: c.useProxyPool });
  const { data: ad } = useQuery({ queryKey: ['addresses'], queryFn: () => apiGet<{ items: AddressRow[] }>('/api/addresses', true), enabled: c.useAddressPool });
  const pxN = (px?.items || []).filter((x) => x.status === 'active').length;
  const adN = (ad?.items || []).filter((x) => x.status === 'active').length;

  return (
    <section className="card">
      <div className="eb-top"><span className="idx">1</span><h3>数据导入</h3><span className="head-hint">每类一行一条,或点「上传」从文件导入{c.isPython ? ' · 本引擎需有代理' : ''}</span></div>
      <div className="data-grid">
        <DataCol kind="account" label="账号凭证" hint={<code>email:password</code>} placeholder={'user1@firstmail.com:原密码1\nuser2@firstmail.com:原密码2'} value={c.data.account} onChange={(v) => c.setData((s) => ({ ...s, account: v }))} fname={c.fname.account} onFile={c.onFile} />
        <DataCol kind="proxy" label="代理" hint={c.isPython ? <><code>host:port:user:pass</code> · 必填</> : <><code>host:port:user:pass</code>,可留空</>} placeholder="1.2.3.4:8080:user:pass" value={c.data.proxy} onChange={(v) => c.setData((s) => ({ ...s, proxy: v }))} fname={c.fname.proxy} onFile={c.onFile}
          extra={<PoolToggle on={c.useProxyPool} set={c.setUseProxyPool} label="用代理池" />}
          disabled={c.useProxyPool} disabledNote={<span>将用<b>已保存的代理池</b>:可用 <b style={{ color: 'var(--success)' }}>{pxN}</b> 条 · 运行时随机分配。<br /><Link to="/proxies" style={{ color: 'var(--primary-text)' }}>去管理代理池 →</Link></span>} />
        <DataCol kind="card" label="卡池" hint={<>每行一卡,自动解析</>} placeholder={'4111 1111 1111 1111  02/29  093\n4111111111111111|05/30|130'} value={c.data.card} onChange={(v) => c.setData((s) => ({ ...s, card: v }))} fname={c.fname.card} onFile={c.onFile} extra={<button type="button" className="btn btn-soft btn-sm" onClick={c.importCards} style={{ marginLeft: 6 }}>导入卡池</button>} />
        <DataCol kind="address" label="账单地址" hint={<><code>姓名|街道|城市|州|邮编</code></>} placeholder={'姓名|街道|城市|州|邮编,或直接传带表头的 CSV\nKatherine Lee|128 NW 11th Ave|Portland|Oregon|97209'} value={c.data.address} onChange={(v) => c.setData((s) => ({ ...s, address: v }))} fname={c.fname.address} onFile={c.onFile}
          extra={!c.isPython && <PoolToggle on={c.useAddressPool} set={c.setUseAddressPool} label="用地址池" />}
          disabled={c.isPython || c.useAddressPool}
          disabledNote={c.isPython
            ? <span>Python 引擎(Selenium / 混合 / 分流)由流水线<b>自动生成账单地址</b>,此处填写或地址池<b>均不生效</b>。</span>
            : <span>将用<b>已保存的地址池</b>:可用 <b style={{ color: 'var(--success)' }}>{adN}</b> 条。<br /><Link to="/addresses" style={{ color: 'var(--primary-text)' }}>去管理地址池 →</Link></span>} />
      </div>
    </section>
  );
}
