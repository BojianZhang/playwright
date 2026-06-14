// 主控制台(壳):持有全部配置 state + 阶段链 + 数据解析 + 回显 + SSE/onRun/buildPayload,
// 经 ConsoleProvider 下发给向导各步骤;监控区(MonitorPanel)与向导同级常驻(切步不丢 SSE)。
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '../lib/toast';
import { apiPost } from '../lib/api';
import { useJobStream } from '../lib/useJobStream';
import { parseKind, KIND_LABEL, type Kind } from '../lib/parse';
import type { StartJobResp } from '../lib/types';
import { EchoModal } from '../features/EchoModal';
import { PolicyModal } from '../features/PolicyModal';
import { ConsoleProvider, type ConsoleCtx, type Chk, type Fname } from '../features/console/ConsoleStateContext';
import Wizard from '../features/console/Wizard';
import MonitorPanel from '../features/console/MonitorPanel';
import { useStrategies } from '../features/console/useStrategies';
import { useEngineConfigs } from '../features/console/useEngineConfigs';
import { activeOpts } from '../lib/strategySchema';
import { engineActiveOpts } from '../lib/engineSchema';
import { BILL_CHAIN, DEF_TPL_OK, DEF_TPL_FAIL, ENGINE_LABEL, type Stage, type Engine } from '../features/console/shared';

export default function ConsolePage() {
  const qc = useQueryClient();
  const toast = useToast();

  // —— 配置状态 ——
  const [unifiedPwd, setUnifiedPwd] = useState('');
  const [pwdInvalid, setPwdInvalid] = useState(false);
  const [mode, setMode] = useState('auto');
  const [conc, setConc] = useState('1');
  const [count, setCount] = useState('0');
  const [chk, setChk] = useState<Chk>({ headed: false, resume: true, humanLike: false });
  const [browserProvider, setBrowserProvider] = useState('none');
  const [envIds, setEnvIds] = useState('');
  const [useProxyPool, setUseProxyPool] = useState(false);
  const [useAddressPool, setUseAddressPool] = useState(false);
  const [useAdspowerPool, setUseAdspowerPool] = useState(false);
  const [useDispatch, setUseDispatch] = useState(false);
  const [dispatchTargets, setDispatchTargets] = useState<{ nodeId: string; url: string; self?: boolean }[]>([]);
  const [shipResources, setShipResources] = useState(true);  // 派发时把本机资源(代理分片/卡分片冻结/地址·密钥复制)下发给子机

  // 环节命名策略预设:各环节"业务参数"(Key名/卡次数/金额)从这里取。
  const { data: strategies } = useStrategies();
  // 引擎配置:该引擎"怎么跑"的技术行为(填卡/求解/换IP/环境/分流)从激活预设取。
  const { data: engineConfigs } = useEngineConfigs();

  // —— 阶段链 ——
  const [stages, setStages] = useState<Record<Stage, boolean>>({ key: true, addr: false, card: false, charge: false, pwd: false });
  // pwdGateOk 定义下移到 engine 之后(见下方),这里只留阶段链逻辑。
  function clickChip(s: Stage) {
    const py = engine !== 'playwright';   // Python(selenium/hybrid/split):改密与充值无关,只需 取Key + 统一密码
    setStages((prev) => {
      const next = { ...prev };
      if (s === 'key') next.key = !prev.key;
      else if (s === 'pwd') {
        if (prev.pwd) next.pwd = false;
        else if (!unifiedPwd.trim()) { toast.push('改密需先填「统一密码」', 'err'); return prev; }
        else { next.key = true; if (!py) BILL_CHAIN.forEach((x) => (next[x] = true)); next.pwd = true; }  // PW 才连带点亮账单链
      } else {
        const idx = BILL_CHAIN.indexOf(s); const turnOn = !prev[s];
        if (turnOn) for (let i = 0; i <= idx; i++) next[BILL_CHAIN[i]] = true;
        else for (let i = idx; i < BILL_CHAIN.length; i++) next[BILL_CHAIN[i]] = false;
      }
      if (next.pwd && !(next.key && (py || next.charge) && unifiedPwd.trim())) next.pwd = false;
      return next;
    });
  }
  const deriveBillingAction = () => stages.charge ? 'charge' : stages.card ? 'card' : stages.addr ? 'address' : 'none';

  // —— 数据导入 ——
  const [data, setData] = useState<Record<Kind, string>>({ account: '', proxy: '', card: '', address: '' });
  const [fname, setFname] = useState<Record<Kind, Fname>>({ account: { cls: '', text: '' }, proxy: { cls: '', text: '' }, card: { cls: '', text: '' }, address: { cls: '', text: '' } });
  function onFile(kind: Kind, file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const { kept, ignored } = parseKind(kind, String(reader.result));
      if (!kept.length) { setFname((s) => ({ ...s, [kind]: { cls: 'err', text: `✕ 没识别出符合「${KIND_LABEL[kind]}」的数据(忽略 ${ignored} 行)—— 传错文件了?` } })); return; }
      setData((s) => { const prev = s[kind].replace(/\s+$/, ''); return { ...s, [kind]: prev ? `${prev}\n${kept.join('\n')}` : kept.join('\n') }; });
      setFname((s) => ({ ...s, [kind]: { cls: 'ok', text: `✓ 解析出 ${kept.length} 条${ignored ? ` · 忽略 ${ignored} 行` : ''}` } }));
    };
    reader.onerror = () => setFname((s) => ({ ...s, [kind]: { cls: 'err', text: '✕ 读取失败' } }));
    reader.readAsText(file);
  }
  async function importCards() {
    if (!data.card.trim()) { setFname((s) => ({ ...s, card: { cls: 'err', text: '卡池框为空' } })); return; }
    setFname((s) => ({ ...s, card: { cls: '', text: '导入中…' } }));
    const cardMaxUses = Number(activeOpts(strategies, 'card', 'playwright').cardMaxUses) || 10;  // 用加卡环节激活预设的每卡上限
    try {
      const d = await apiPost<{ added?: number; updated?: number; available?: number; parseErrors?: unknown[] }>('/api/cards/import', { cardsRaw: data.card, maxUses: cardMaxUses });
      setFname((s) => ({ ...s, card: { cls: 'ok', text: `✓ 新增 ${d.added || 0} · 更新 ${d.updated || 0} · 可用 ${d.available || 0}${(d.parseErrors || []).length ? ` · ${(d.parseErrors || []).length} 行无法解析` : ''}` } }));
      setData((s) => ({ ...s, card: '' }));
      qc.invalidateQueries({ queryKey: ['cards'] });
      toast.push('卡池导入成功', 'ok');
    } catch (e) { setFname((s) => ({ ...s, card: { cls: 'err', text: `导入失败:${(e as Error).message}` } })); }
  }

  // —— 回显模板 + 弹窗 ——
  const [tplOk, setTplOk] = useState(DEF_TPL_OK);
  const [tplFail, setTplFail] = useState(DEF_TPL_FAIL);
  const [echoModal, setEchoModal] = useState<null | 'success' | 'fail'>(null);
  const [policyOpen, setPolicyOpen] = useState(false);

  // —— 引擎选择 + Python 引擎高级参数 ——
  const [engine, setEngine] = useState<Engine>('playwright');
  const [runEngine, setRunEngine] = useState<Engine>('playwright');
  const isPython = engine !== 'playwright';
  // 改密门控:Playwright 沿用「取Key + 充值 + 统一密码」;Python(selenium/split)改密与充值无关,只需「取Key + 统一密码」。
  const pwdGateOk = stages.key && (isPython || stages.charge) && !!unifiedPwd.trim();

  // 切引擎时按"该引擎实际能跑什么"归一阶段链,让「选什么 = 跑什么」在每个引擎下都成立:
  //  - 混合/分流:流水线打包跑 注册→取Key→绑地址→加卡 → 强制点亮 key/addr/card(UI 里这两步锁定);改密可选(绑成后改邮箱密码)。
  //  - Selenium:无独立绑地址步(绑地址内含于加卡),孤立的 addr(未开加卡)取消,避免"勾了绑地址却空跑"。
  //  - Playwright:全部可单独控制,不强改。
  function selectEngine(e: Engine) {
    const forced = (e === 'hybrid' || e === 'split') && (!stages.key || !stages.addr || !stages.card);
    const dropAddr = e === 'selenium' && stages.addr && !stages.card;
    setEngine(e);
    setStages((prev) => {
      const next = { ...prev };
      if (e === 'hybrid' || e === 'split') { next.key = true; next.addr = true; next.card = true; }   // 改密(pwd)不强改:混合/分流现支持改密,保留用户选择
      else if (e === 'selenium') { if (next.addr && !next.card) next.addr = false; }
      return next;
    });
    if (forced) toast.push(`已切到${e === 'hybrid' ? '混合' : '分流'}引擎:打包全流程,已自动开启 取Key+绑地址+加卡`, 'ok');
    else if (dropAddr) toast.push('已切到 Selenium:无独立绑地址步,已取消单独的「绑地址」', 'ok');
  }

  // —— SSE 监控 ——
  // 实时联动:每完成一个账号(成功或失败),关联面板(卡池/账单/错误/账号/总览/使用)一起刷新,出问题能立刻在各页看到。
  const linkRefresh = () => ['cards', 'billing', 'accounts', 'errors', 'overview', 'analytics'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const runningRef = useRef(false);
  // 提交在途锁:从点击到 /jobs|/api/run|/api/dispatch 返回这段时间内,挡掉重复点击(否则双击会起两个任务、含充值真重复扣钱)。
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const stream = useJobStream({
    onCardStats: () => qc.invalidateQueries({ queryKey: ['cards'] }),
    onBillingStats: () => qc.invalidateQueries({ queryKey: ['billing'] }),
    onFailureStats: () => qc.invalidateQueries({ queryKey: ['errors'] }),
    onAccountSuccess: linkRefresh,
    onAccountFailed: linkRefresh,
    // 任务自然跑完:复位 runningRef,否则按钮已显示「开始执行」但 onRun 仍走停止分支吞掉首次点击(要点两次)。
    onDone: () => { runningRef.current = false; linkRefresh(); },
    // SSE 永久断开(服务重启等):同样复位,否则按钮永远停在「停止」、进度永不结束。
    onError: () => { runningRef.current = false; setRunHint({ html: '与服务的实时连接已断开,已停止监听(可重新点开始执行)。', danger: true }); },
  });
  const { state } = stream;
  const [jobId, setJobId] = useState<string | null>(null);
  const [runHint, setRunHint] = useState<{ html?: string; danger?: boolean }>({});

  // 接管外部已起的任务实时进度:从「续跑这批」跳转过来 /console?attach=<jobId>&total=<n>&engine=<e>,
  // 直接挂上该 job 的 SSE,无需在本页重新提交。一次性(用完清掉 query,刷新不重复接管)。
  const [searchParams, setSearchParams] = useSearchParams();
  const attachedRef = useRef(false);
  useEffect(() => {
    if (attachedRef.current) return;
    const attach = searchParams.get('attach');
    if (!attach) return;
    attachedRef.current = true;
    const total = Number(searchParams.get('total')) || 0;
    const eng = (searchParams.get('engine') || 'selenium') as Engine;
    setJobId(attach); setRunEngine(eng); runningRef.current = true;
    stream.start(attach, total);
    setRunHint({ html: `已接管续跑任务 <b>${attach.slice(-14)}</b>(引擎 <b>${ENGINE_LABEL[eng] || eng}</b>)· 运行中 —— 实时进度见下方。断点续跑会自动跳过已完成的号。` });
    setSearchParams({}, { replace: true });
    window.scrollTo({ top: 0, behavior: 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  function buildPayload() {
    const key = activeOpts(strategies, 'key', 'playwright');
    const card = activeOpts(strategies, 'card', 'playwright');
    const chg = activeOpts(strategies, 'charge', 'playwright');
    const eng = engineActiveOpts(engineConfigs, 'playwright'); // 引擎配置:填卡方式 + 各步转人工/选卡/脏IP
    return {
      accountsRaw: data.account, proxiesRaw: data.proxy, cardsRaw: data.card, billingAddressesRaw: data.address,
      headed: chk.headed, resume: chk.resume,
      manualCaptchaFallback: !!eng.manualCaptcha, manualBillingFallback: !!eng.manualBilling, manualCardPick: !!eng.manualCardPick,
      humanLike: chk.humanLike, skipCardOnDirtyIp: !!eng.skipDirtyIp,
      adspowerEnvIdsRaw: envIds, browserProvider, cardFillEngine: String(eng.cardFillEngine),
      concurrency: Number(conc) || 1, count: Number(count) || 0,
      mode: mode === 'login' ? 'login' : 'register',
      unifiedPassword: unifiedPwd.trim(),
      apiKeyName: String(key.apiKeyName || '').trim(), apiKeyExpiration: String(key.apiKeyExpiration),
      billingAction: deriveBillingAction(), doApiKey: stages.key, doPasswordChange: stages.pwd && pwdGateOk,
      topUpAmount: Math.max(5, Number(chg.topUpAmount) || 5), maxCardTries: Math.max(1, Math.min(10, Number(card.maxCardTries) || 3)),
      cardMaxUses: Number(card.cardMaxUses) || 10,
      addressMode: (useAddressPool || data.address.trim()) ? 'pool' : 'random',
      addressStates: 'Oregon, Delaware, Montana, New Hampshire', billingAddressStrategy: 'random',
      useProxyPool, useAddressPool, useAdspowerPool,
      successTemplate: tplOk, failureTemplate: tplFail,
    };
  }

  // Python 引擎(selenium/hybrid/split)的 /api/run payload
  function buildRunPayload() {
    const card = activeOpts(strategies, 'card', engine);   // 业务:每卡次数
    const chg = activeOpts(strategies, 'charge', engine);  // 业务:充值金额
    const eng = engineActiveOpts(engineConfigs, engine);   // 引擎配置:求解/换IP/冷却/重开/超时/环境生命周期/分流
    // 合法的 0(如"换IP 0 次=不换")要保留、不被 `|| 默认` 顶掉;但留空(空串)= 用默认
    // (Number('')===0 会把"清空字段"误判成显式 0,故先判空白)。
    const num = (v: string | boolean | undefined, def: number) => { const s = String(v ?? '').trim(); if (s === '') return def; const n = Number(s); return Number.isFinite(n) ? n : def; };
    return {
      engine,
      accountsRaw: data.account, proxiesRaw: data.proxy, cardsRaw: data.card,
      count: Number(count) || 0, concurrency: Number(conc) || 1,
      resume: chk.resume,   // 断点续跑:取消勾选 → 后端 --no-resume 忽略已完成/坏邮箱/被拒,整组强制重跑(对齐 Playwright)
      unifiedPassword: unifiedPwd.trim(),
      doApiKey: stages.key, doCard: stages.card, doPurchase: stages.charge, doChangePw: stages.pwd && pwdGateOk,
      amount: Math.max(5, Number(chg.topUpAmount) || 5), cardMaxUses: Number(card.cardMaxUses) || 10,
      solveHcaptcha: eng.solveHcaptcha,
      maxRotations: num(eng.maxRotations, 3), cooldownHours: num(eng.cooldownHours, 3), maxReopen: num(eng.maxReopen, 3),
      cardDeadline: num(eng.cardDeadline, 0), solveFutileCap: eng.solveFutileCap, maxHcaptchaCardSwaps: eng.maxHcaptchaCardSwaps,
      hcRecheckWait: num(eng.hcRecheckWait, 5),
      isolate: !!eng.isolate, manualCard: !!eng.manualCard, noDeleteEnv: !!eng.noDeleteEnv, noGc: !!eng.noGc,
      splitRatio: num(eng.splitRatio, 0.5), crossHandoff: eng.crossHandoff !== false,
      useProxyPool, useAddressPool, useAdspowerPool,
      successTemplate: tplOk, failureTemplate: tplFail,
    };
  }

  async function onRun() {
    if (submittingRef.current) return;  // 提交在途:忽略重复点击(防双击/连点派发重复起任务、重复扣钱)
    if (runningRef.current) { // 停止
      if (runEngine !== 'playwright' && jobId) { try { await apiPost('/api/jobs/stop', { jobId }); } catch { /* ignore */ } }
      stream.close(); runningRef.current = false;
      setRunHint({ html: runEngine === 'playwright' ? '已停止监听。断点续跑已记录进度,再次执行会自动跳过已完成阶段。' : '已发停止:杀 Python 进程树(含浏览器),收尾后本次结果落历史。' });
      return;
    }
    if (!data.account.trim()) { setRunHint({ html: '请先填写或上传「账号凭证」(在第 1 步「数据」)', danger: true }); return; }
    if (engine === 'playwright' && !unifiedPwd.trim()) { setPwdInvalid(true); setRunHint({ html: '请先填写「统一密码」—— 不能留空,否则后续改密很麻烦(在第 2 步「引擎 & 全局」)', danger: true }); return; }
    if (isPython && !data.proxy.trim() && !useProxyPool) { setRunHint({ html: 'Python 引擎建 AdsPower 环境必须配代理(在第 1 步「数据」)', danger: true }); return; }
    submittingRef.current = true; setSubmitting(true);
    try {
      // 多机派发:把这批拆给目标机各自跑(各机独立,结果回「结果聚合」),不在本机建 SSE。
      if (useDispatch) {
        const targets = dispatchTargets.length ? dispatchTargets : [{ nodeId: '本机', url: 'self', self: true }];
        setRunHint({ html: '派发中…' });
        try {
          const body = { engine, payload: { ...(engine === 'playwright' ? buildPayload() : buildRunPayload()), shipResources }, targets };
          const d = await apiPost<{ dispatched: number; targets: number; total: number; slices: { target: string; accepted: number; ok: boolean; error?: string }[] }>('/api/dispatch', body);
          const detail = d.slices.map((s) => `${s.target}:${s.ok ? s.accepted + '✓' : '失败(' + (s.error || '') + ')'}`).join(' · ');
          setRunHint({ html: `已派发 <b>${d.total}</b> 账号 → <b>${d.dispatched}/${d.targets}</b> 台机接受。各机独立跑,结果见<a href="/results" style="color:var(--primary-text)">结果聚合</a>。<br>${detail}`, danger: d.dispatched === 0 });
        } catch (e) { setRunHint({ html: '派发错误:' + (e as Error).message, danger: true }); }
        return;
      }
      setRunHint({ html: '提交中…' });
      try {
        const endpoint = engine === 'playwright' ? '/jobs' : '/api/run';
        const body = engine === 'playwright' ? buildPayload() : buildRunPayload();
        const d = await apiPost<StartJobResp>(endpoint, body);
        setJobId(d.jobId); setRunEngine(engine); runningRef.current = true;
        stream.start(d.jobId, d.accepted || 0);
        setRunHint({ html: `已接受 <b>${d.accepted}</b> 个账号 · 引擎 <b>${ENGINE_LABEL[engine]}</b> · 运行中 —— 实时进度见下方。` });
      } catch (e) { setRunHint({ html: '错误:' + (e as Error).message, danger: true }); }
    } finally { submittingRef.current = false; setSubmitting(false); }
  }

  const failed = state.failed;
  function requeue() {
    if (!failed.length) return;
    setData((s) => ({ ...s, account: failed.map((d) => `${d.email}:${d.originalPassword || d.password || ''}`).join('\n') }));
    setMode('login');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setRunHint({ html: `已把 ${failed.length} 个失败账号回填(已切「仅登录续跑」),核对后点开始执行。` });
  }

  const ctx: ConsoleCtx = {
    engine, setEngine: selectEngine, isPython,
    unifiedPwd, setUnifiedPwd, pwdInvalid, setPwdInvalid,
    mode, setMode, conc, setConc, count, setCount,
    chk, setChk, browserProvider, setBrowserProvider, envIds, setEnvIds,
    stages, clickChip, pwdGateOk,
    data, setData, fname, onFile, importCards,
    useProxyPool, setUseProxyPool, useAddressPool, setUseAddressPool, useAdspowerPool, setUseAdspowerPool,
    useDispatch, setUseDispatch, dispatchTargets, setDispatchTargets, shipResources, setShipResources,
    tplOk, setTplOk, tplFail, setTplFail, setEchoModal, setPolicyOpen,
  };

  return (
    <main className="page">
      <div className="zone"><span className="z-no">A</span><h2>任务配置</h2><span className="z-hint">分步填写,可随时回上一步改</span><span className="z-line" /></div>

      <ConsoleProvider value={ctx}><Wizard /></ConsoleProvider>

      <MonitorPanel state={state} isPython={(state.running ? runEngine : engine) !== 'playwright'} engine={state.running ? runEngine : engine} submitting={submitting} jobId={jobId} runHint={runHint} onRun={onRun} requeue={requeue} onOpenPolicy={() => setPolicyOpen(true)} />

      <EchoModal kind="success" open={echoModal === 'success'} onClose={() => setEchoModal(null)} value={tplOk} onSave={setTplOk} />
      <EchoModal kind="fail" open={echoModal === 'fail'} onClose={() => setEchoModal(null)} value={tplFail} onSave={setTplFail} />
      <PolicyModal open={policyOpen} onClose={() => setPolicyOpen(false)} />
    </main>
  );
}
