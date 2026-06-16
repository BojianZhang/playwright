// 向导第 2 步:引擎 & 全局。
// 结构:运行引擎 → 引擎配置(就地可折叠编辑 + 浏览器/环境)→ 全局设置(与引擎无关)→ 多机派发。
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Icon } from '../../lib/icons';
import { apiGet } from '../../lib/api';
import type { AdsPowerEnv } from '../../lib/types';
import { useConsole } from './ConsoleStateContext';
import { useEngineConfigs } from './useEngineConfigs';
import EngineConfigEditor from './EngineConfigEditor';
import { Field, Check, ENGINE_LIST, ENGINE_LABEL } from './shared';

export default function StepEngine() {
  const c = useConsole();
  return (
    <>
      {/* 运行引擎 */}
      <section className="card pipeline-band" style={{ paddingBottom: 14 }}>
        <div className="pb-head"><span className="pb-icon"><Icon name="cpu" size={14} /></span><h3>运行引擎</h3><span className="pb-sub">选一种跑法 · 除「Playwright(内置)」外都需本机先装好 AdsPower 并填代理,否则跑不起来</span></div>
        <div className="pipeline">
          {ENGINE_LIST.map((e) => (
            <div key={e.key} className={'stage' + (c.engine === e.key ? ' on' : '')} style={{ flexDirection: 'column', gap: 3, alignItems: 'flex-start', textAlign: 'left' }} onClick={() => c.setEngine(e.key)}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span className="schk"><Icon name="check" size={10} /></span>{e.label}</span>
              <span style={{ fontSize: 10.5, fontWeight: 400, opacity: 0.85, paddingLeft: 24 }}>{e.sub}</span>
            </div>
          ))}
        </div>
      </section>

      <div className="section-gap" />
      <EngineConfig />

      <div className="section-gap" />

      {/* 全局运行设置(与引擎无关) */}
      <section className="card">
        <div className="eb-top"><span className="idx c-info">2</span><h3>全局设置</h3><span className="head-hint">所有账号通用、与引擎无关的选项</span>
          {/* 错误处理规则=内置(Playwright)引擎的重试策略;Python 流水线有自己的重试,不读它 */}
          {!c.isPython && <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={() => c.setPolicyOpen(true)}><Icon name="info" size={14} />错误处理规则</button>}
        </div>
        <div className={'set-hero' + (c.pwdInvalid && !c.unifiedPwd.trim() ? ' invalid' : '')}>
          <span className="set-hero-ic"><Icon name="lock" size={17} /></span>
          <div className="set-hero-field">
            <div className="label"><span className="l-name">统一密码</span>{c.engine === 'playwright' ? <span className="req-badge">必填</span> : <span className="l-hint">选填</span>}</div>
            <input type="text" value={c.unifiedPwd} placeholder={c.engine === 'playwright' ? '如 MyNewPass#2026' : '留空=用各账号邮箱密码'}
              onChange={(e) => { c.setUnifiedPwd(e.target.value); if (c.pwdInvalid) c.setPwdInvalid(!e.target.value.trim()); }} />
          </div>
          {c.engine === 'playwright' ? (
            <p className="set-hero-help"><b>OpenRouter 注册就用它</b>,全流程跑完后再把邮箱密码从原密码改成它。<b className="warn">不能留空</b> —— 否则只能按「原邮箱:密码」保存,后续改密会很费劲。</p>
          ) : (
            <p className="set-hero-help">作 <b>OpenRouter 登录密码</b>。Selenium 仅在勾「改密」时用作目标新密码;混合引擎用作登录密码;<b>留空 = 用每个账号自己的邮箱密码</b>(可不填)。</p>
          )}
        </div>
        <div className="set-grid">
          {/* 任务模式仅 Playwright 消费;Python 按本地进度自动判定(没注册就注册/已注册直登),不读它 */}
          {!c.isPython && <Field name="任务模式" hint="已注册的号直接登录、接着上次继续"><select value={c.mode} onChange={(e) => c.setMode(e.target.value)}><option value="auto">自动(没注册就注册,已注册则登录)</option><option value="register">只注册</option><option value="login">只登录,接着上次继续</option></select></Field>}
          <Field name="并发数" hint="同时跑几个账号"><input type="number" value={c.conc} min={1} onChange={(e) => c.setConc(e.target.value)} /></Field>
          <Field name="处理数量" hint="0 = 全部"><input type="number" value={c.count} min={0} onChange={(e) => c.setCount(e.target.value)} /></Field>
        </div>
        <div className="set-foot" style={{ display: 'block' }}>
          {c.isPython ? (
            <div style={{ padding: '11px 14px', borderRadius: 'var(--r-md)', background: 'var(--info-weak)', border: '1px solid var(--info-bd)', fontSize: 12, color: 'var(--text-2)', lineHeight: 1.65 }}>
              <b style={{ color: 'var(--info)' }}>本引擎({ENGINE_LABEL[c.engine]})不读这些 Playwright 专用开关</b>:浏览器由 AdsPower 接管(<b>恒有头</b>)、<b>断点续跑恒开</b>、任务模式按本地进度自动判定、<b>拟人操作不适用</b>。故此处不显示,避免「设了不生效」。
            </div>
          ) : (
            <div className="check-grid">
              <Check label="显示浏览器窗口" sub="跑的时候弹出浏览器界面" v={c.chk.headed} on={(v) => c.setChk((x) => ({ ...x, headed: v }))} />
              <Check label="断点续跑" sub="接着上次继续,跳过已完成的步骤" v={c.chk.resume} on={(v) => c.setChk((x) => ({ ...x, resume: v }))} />
              <Check label="拟人操作" sub="模拟真人(鼠标轨迹+提交前停顿),更不易被识别但更慢" v={c.chk.humanLike} on={(v) => c.setChk((x) => ({ ...x, humanLike: v }))} />
            </div>
          )}
        </div>
      </section>

      <div className="section-gap" />
      <MultiMachine />
    </>
  );
}

// 引擎配置小节:控制台「选引擎 + 引用配置」,并可【就地展开编辑】当前引擎的激活预设(默认折叠保持清爽)。
// 同时收拢「浏览器 / 环境(本次运行)」—— 让同一引擎"怎么跑"集中一处,不再散落到全局设置。
// 注:浏览器接管/环境编号是"本次运行的资源选择"(存控制台 state,随 payload 下发),与预设里的引擎行为分开标注。
function EngineConfig() {
  const c = useConsole();
  const { data } = useEngineConfigs();
  const en = data?.engines?.[c.engine];
  const activeName = en?.presets.find((p) => p.id === en.activeId)?.name;
  const { data: ap } = useQuery({ queryKey: ['adspower'], queryFn: () => apiGet<{ items: AdsPowerEnv[] }>('/api/adspower', true), enabled: c.useAdspowerPool && c.browserProvider !== 'none' });
  const apN = (ap?.items || []).filter((x) => x.status === 'active').length;
  return (
    <section className="card">
      <div className="eb-top">
        <span className="idx c-info"><Icon name="sliders" size={12} /></span>
        <h3>引擎配置</h3>
        <span className="head-hint">{ENGINE_LABEL[c.engine]} 怎么跑 · 当前预设「{activeName || '…'}」</span>
        <Link to="/engine-config" className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }}><Icon name="external" size={12} />管理 / 多预设</Link>
      </div>

      {/* 就地编辑(默认折叠):展开后切预设 / 改字段 / 保存,无需跳页 */}
      <details className="adv">
        <summary>展开编辑当前引擎配置<span className="adv-hint">切预设 · 填卡 / 求解 / 换IP / 环境 / 分流 · 改完点保存</span></summary>
        <div style={{ padding: '4px 18px 16px' }}>
          <EngineConfigEditor engine={c.engine} />
        </div>
      </details>

      {/* 浏览器 / 环境(本次运行)—— 资源选择,非引擎预设 */}
      <div style={{ borderTop: '1px solid var(--border)', padding: '12px 18px 16px' }}>
        <div className="label" style={{ marginBottom: c.isPython ? 0 : 8 }}>
          <span className="l-name">浏览器 / 环境</span>
          <span className="l-hint">本次运行用哪个浏览器、哪些环境(按次选,不进预设)</span>
        </div>
        {c.isPython ? (
          <div style={{ marginTop: 8, padding: '11px 14px', borderRadius: 'var(--r-md)', background: 'var(--info-weak)', border: '1px solid var(--info-bd)', fontSize: 12, color: 'var(--text-2)', lineHeight: 1.65 }}>
            <b style={{ color: 'var(--info)' }}>本引擎({ENGINE_LABEL[c.engine]})用 AdsPower 指纹浏览器跑</b>(自动建 / 刷新指纹 / 回收环境)—— 请确保<b>本机 AdsPower 已启动</b>,并在「数据」步填好<b>代理</b>。填卡走原生 CDP,无需额外设置。<br />Local API 地址 / 密钥在 <Link to="/settings" style={{ color: 'var(--primary-text)' }}>设置中心</Link> 或 <Link to="/adspower" style={{ color: 'var(--primary-text)' }}>AdsPower 端点池</Link> 配(本机一般免密钥)。
          </div>
        ) : (
          <>
            <select value={c.browserProvider} onChange={(e) => c.setBrowserProvider(e.target.value)}>
              <option value="none">不接管(用内置浏览器)</option>
              <option value="adspower">接管 AdsPower</option>
              <optgroup label="其它指纹浏览器(已接入)">
                <option value="bitbrowser">BitBrowser(比特)</option><option value="dolphin">Dolphin Anty</option><option value="gologin">GoLogin</option>
              </optgroup>
              <optgroup label="未接入 · 暂不可用">
                <option value="hubstudio">HubStudio</option><option value="morelogin">MoreLogin</option><option value="multilogin">Multilogin</option><option value="vmlogin">VMLogin</option>
              </optgroup>
            </select>
            {c.browserProvider !== 'none' && (
              <div className="field" style={{ margin: '12px 0 0' }}>
                <div className="label"><span className="l-name">环境编号</span><span className="l-hint">指纹浏览器里每个环境的编号,一行一个或逗号隔开;每账号分一个</span>
                  <label className="check" style={{ marginLeft: 'auto', fontSize: 11.5 }}><input type="checkbox" checked={c.useAdspowerPool} onChange={(e) => c.setUseAdspowerPool(e.target.checked)} /><span className="box"><Icon name="check" size={11} /></span>用环境池</label>
                </div>
                {c.useAdspowerPool
                  ? <div className="pool-note">将用<b>已保存的 AdsPower 环境池</b>:可用 <b style={{ color: 'var(--success)' }}>{apN}</b> 个。<Link to="/adspower" style={{ color: 'var(--primary-text)' }}>去管理 →</Link></div>
                  : <textarea value={c.envIds} rows={2} placeholder={'k1db9yk8\nk1db9yk7\nk1db9yk5'} onChange={(e) => c.setEnvIds(e.target.value)} />}
              </div>
            )}
            {c.browserProvider === 'adspower' && (
              <div className="pool-note" style={{ marginTop: 8 }}>AdsPower 的 <b>Local API 地址 / 密钥</b>在 <Link to="/settings" style={{ color: 'var(--primary-text)' }}>设置中心</Link> 或 <Link to="/adspower" style={{ color: 'var(--primary-text)' }}>端点池</Link> 配(本机一般免密钥;远程 / 开了鉴权才填)。</div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

// 多机派发:把这批账号拆给多台目标机各自跑(各用自己 AdsPower)。关=只本机。
function MultiMachine() {
  const c = useConsole();
  const { data } = useQuery({ queryKey: ['cluster'], queryFn: () => apiGet<{ nodeId: string; peers: { nodeId: string; url: string }[] }>('/api/cluster', true), enabled: c.useDispatch, refetchInterval: c.useDispatch ? 30000 : false });   // 集群拓扑稳定(peer 注册一次/30s 心跳)→ 表单里 10s 太勤,放宽 30s
  const peers = data?.peers || [];
  const sel = c.dispatchTargets;
  const isSel = (url: string) => sel.some((t) => t.url === url);
  const toggle = (t: { nodeId: string; url: string; self?: boolean }) => c.setDispatchTargets(isSel(t.url) ? sel.filter((x) => x.url !== t.url) : [...sel, t]);
  return (
    <section className="card">
      <div className="eb-top"><span className="idx c-amber"><Icon name="layers" size={12} /></span><h3>多机派发</h3><span className="head-hint">把这批拆给多台机各自跑(各用自己的 AdsPower);关 = 只在本机跑</span></div>
      <div className="set-foot" style={{ display: 'block' }}>
        <div className="check-grid">
          <Check label="启用多机派发" sub="账号按机数轮询拆分,各机独立跑,结果回「结果聚合」汇总" v={c.useDispatch} on={c.setUseDispatch} />
        </div>
        {c.useDispatch && (
          <div style={{ marginTop: 12 }}>
            <p className="help" style={{ margin: '0 0 10px' }}>选目标机(需在线且同 token)。本机=loopback。AdsPower 端点/环境始终用各机自己的(本机物理资源)。</p>
            <div className="check-grid">
              <Check label={`本机 (${data?.nodeId || '…'})`} sub="loopback 到自身" v={isSel('self')} on={() => toggle({ nodeId: data?.nodeId || '本机', url: 'self', self: true })} />
              {peers.map((p) => <Check key={p.url} label={p.nodeId} sub={p.url} v={isSel(p.url)} on={() => toggle({ nodeId: p.nodeId, url: p.url })} />)}
            </div>
            {!peers.length && <p className="help" style={{ margin: '10px 0 0' }}>无在线子机。多机需子机在「设置中心 → 多机集群」配中心机地址注册;现在仅可派发到本机。</p>}
            <div className="check-grid" style={{ marginTop: 12 }}>
              <Check label="下发本机资源给子机" sub="代理/卡按机分片不重叠(卡下发后中心冻结防重复扣款)·地址/验证码/邮箱密钥复制;关=各机用自己的池" v={c.shipResources} on={c.setShipResources} />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
