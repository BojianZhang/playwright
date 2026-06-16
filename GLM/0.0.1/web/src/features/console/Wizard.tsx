// 控制台配置向导:顶部可点步骤条 + 上一步/下一步,内容区按步渲染。
// 导航自由(可任意跳步);每步算一个状态点(待填/有问题/就绪),真正的运行前校验仍在壳的 onRun 里兜底。
import { useState } from 'react';
import { Icon } from '../../lib/icons';
import { useConsole } from './ConsoleStateContext';
import StepData from './StepData';
import StepEngine from './StepEngine';
import StepStages from './StepStages';
import StepEcho from './StepEcho';

type Status = 'ok' | 'warn' | 'idle';
const STEPS = [
  { n: 1, label: '数据', icon: 'upload' as const },
  { n: 2, label: '引擎 & 全局', icon: 'cpu' as const },
  { n: 3, label: '环节策略', icon: 'activity' as const },
  { n: 4, label: '回显模板', icon: 'grid' as const },
];

export default function Wizard() {
  const c = useConsole();
  const [step, setStep] = useState(1);

  // 每步状态点:warn=有需要补的硬条件,ok=该步关键项已就绪,idle=无需校验
  const status: Record<number, Status> = {
    1: !c.data.account.trim() || (c.isPython && !c.data.proxy.trim()) ? 'warn' : 'ok',
    2: c.engine === 'playwright' && !c.unifiedPwd.trim() ? 'warn' : 'ok',
    3: c.stages.pwd && !c.pwdGateOk ? 'warn' : 'idle',
    4: 'idle',
  };

  function gotoRun() { document.getElementById('run-zone')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }

  return (
    <>
      <nav className="wiz-nav">
        {STEPS.map((s, i) => (
          <div key={s.n} className="wiz-seg">
            <button className={'wiz-step' + (step === s.n ? ' on' : '')} onClick={() => setStep(s.n)}>
              <span className={'wiz-dot ' + status[s.n]}>{status[s.n] === 'warn' ? '!' : s.n}</span>
              <span className="wiz-label"><Icon name={s.icon} size={13} />{s.label}</span>
            </button>
            {i < STEPS.length - 1 && <span className="wiz-line" />}
          </div>
        ))}
      </nav>

      <div className="wiz-body">
        {step === 1 && <StepData />}
        {step === 2 && <StepEngine />}
        {step === 3 && <StepStages />}
        {step === 4 && <StepEcho />}
      </div>

      <div className="wiz-foot">
        <button className="btn btn-ghost" disabled={step === 1} onClick={() => setStep((s) => Math.max(1, s - 1))}><Icon name="chevron" size={14} style={{ transform: 'rotate(180deg)' }} />上一步</button>
        <div style={{ flex: 1 }} />
        <span className="wiz-foot-hint">第 {step} / {STEPS.length} 步 · {STEPS[step - 1].label}</span>
        <div style={{ flex: 1 }} />
        {step < STEPS.length
          ? <button className="btn btn-primary" onClick={() => setStep((s) => Math.min(STEPS.length, s + 1))}>下一步<Icon name="chevron" size={14} /></button>
          : <button className="btn btn-primary" onClick={gotoRun}>去执行<Icon name="chevron" size={14} style={{ transform: 'rotate(90deg)' }} /></button>}
      </div>
    </>
  );
}
