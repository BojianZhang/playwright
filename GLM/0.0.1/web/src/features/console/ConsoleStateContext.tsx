// 控制台 state 容器:壳组件(ConsolePage)持有全部 state,经此 context 下发给各步骤组件,
// 避免 30+ props 钻洞。**不改变 state 形状**——只是把"散在一个大组件里的 useState"集中暴露。
import { createContext, useContext, type Dispatch, type SetStateAction } from 'react';
import type { Kind } from '../../lib/parse';
import type { Stage, Engine } from './shared';

// 全局勾选(运行级,与具体环节、引擎无关)。转人工/选卡/换IP/环境生命周期/分流等已迁入【引擎配置】。
export interface Chk { headed: boolean; resume: boolean; humanLike: boolean }
export interface Fname { cls: string; text: string }

export interface ConsoleCtx {
  // 引擎
  engine: Engine; setEngine: (e: Engine) => void; isPython: boolean;
  // 全局运行设置
  unifiedPwd: string; setUnifiedPwd: (v: string) => void;
  pwdInvalid: boolean; setPwdInvalid: (v: boolean) => void;
  mode: string; setMode: (v: string) => void;
  conc: string; setConc: (v: string) => void;
  count: string; setCount: (v: string) => void;
  chk: Chk; setChk: Dispatch<SetStateAction<Chk>>;
  browserProvider: string; setBrowserProvider: (v: string) => void;
  envIds: string; setEnvIds: (v: string) => void;
  // 阶段链
  stages: Record<Stage, boolean>; clickChip: (s: Stage) => void; pwdGateOk: boolean;
  // 数据导入
  data: Record<Kind, string>; setData: Dispatch<SetStateAction<Record<Kind, string>>>;
  fname: Record<Kind, Fname>; onFile: (k: Kind, f: File) => void; importCards: () => void;
  // 从已保存的资源池选用(开=运行时用池覆盖粘贴文本)
  useProxyPool: boolean; setUseProxyPool: (v: boolean) => void;
  useAddressPool: boolean; setUseAddressPool: (v: boolean) => void;
  useAdspowerPool: boolean; setUseAdspowerPool: (v: boolean) => void;
  // 多机派发(开=把一批拆给多台目标机各自跑)
  useDispatch: boolean; setUseDispatch: (v: boolean) => void;
  dispatchTargets: { nodeId: string; url: string; self?: boolean }[]; setDispatchTargets: (v: { nodeId: string; url: string; self?: boolean }[]) => void;
  shipResources: boolean; setShipResources: (v: boolean) => void;
  // 回显模板 + 弹窗
  tplOk: string; setTplOk: (v: string) => void;
  tplFail: string; setTplFail: (v: string) => void;
  setEchoModal: (v: null | 'success' | 'fail') => void;
  setPolicyOpen: (v: boolean) => void;
}

const Ctx = createContext<ConsoleCtx | null>(null);
export const ConsoleProvider = Ctx.Provider;
export function useConsole(): ConsoleCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useConsole 必须在 ConsoleProvider 内使用');
  return c;
}
