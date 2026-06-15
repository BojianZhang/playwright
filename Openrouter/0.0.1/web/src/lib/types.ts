// 后端 /api 数据结构的 TS 类型(对照 server.js + 各数据模块导出)。

export interface NodeInfo { nodeId: string; hostname: string; role: 'master' | 'sub'; centralUrl: string; }

export interface CardRow {
  id: string; masked: string; last4: string; exp: string;
  status: 'active' | 'exhausted' | 'declined' | 'disabled' | 'dispatched';
  maxUses: number; usedCount: number; remaining: number;
  successCount: number; declineCount: number;
  firstUsedAt?: string; lastUsedAt?: string; lastResult?: string; lastError?: string;
  cooldownUntil?: string; disabledReason?: string; inUse?: boolean;
}
export interface CardsResp { cards: CardRow[]; available: number; }

export interface LedgerEntry { at: string; email: string; result: string; charged: number; cardLast4?: string; jobId?: string; error?: string; }
export interface LedgerSummary {
  total: number; success: number; declined: number; totalCharged: number;
  returned?: number; truncated?: boolean;   // entries 是「最近 returned 条 / 共 total」;truncated=列表被截断(KPI 仍按全量算)
  byResult?: Record<string, number>; byCard?: Record<string, { count: number; charged: number }>;
  entries: LedgerEntry[];
}

export interface AccountRow {
  email: string; createdAt?: string; updatedAt?: string;
  registered?: boolean; apiKey?: string; apiKeyName?: string;
  passwordChanged?: boolean; billingStatus?: string; charged?: number; balanceAfter?: number | null;
  purchaseStatus?: 'success' | 'failed' | 'skipped' | 'not-attempted'; purchaseReason?: string;   // 充值结果(明确成功/失败/已充跳过/未充值)
  cardLast4?: string; exitIp?: string; blacklisted?: boolean; blacklistReason?: string;
  durationSec?: number | null;   // 单号端到端耗时(秒)
  originalPassword?: string; password?: string; nodeId?: string; jobId?: string; topUpAmount?: number;
}
export interface StageSummary { total: number; registered: number; key: number; address: number; card: number; charge: number; changepw: number; blacklisted: number; }
export interface AccountsResp { count: number; accounts: AccountRow[]; summary?: StageSummary; }

export interface ErrorEntry { at: string; email?: string; stage?: string; reason: string; action?: string; attempt?: number; jobId?: string; }
export interface ErrorSummary { total: number; returned?: number; truncated?: boolean; byReason: Record<string, number>; byAction: Record<string, number>; entries: ErrorEntry[]; }

export type PolicyAction = 'retry' | 'retry-new-proxy' | 'relogin' | 'blacklist' | 'abort';
export interface PolicyRow {
  code: string; stage?: string; why?: string; settable?: boolean;
  builtin?: { action: PolicyAction; maxRetries: number };
  override?: { action: PolicyAction; maxRetries: number } | null;
  effective?: { action: PolicyAction; maxRetries: number };
}
export interface PolicyResp { actions: PolicyAction[]; policy: PolicyRow[]; }

export interface ClusterPeer { nodeId: string; url: string; ageSec: number; }
export interface ClusterResp { nodeId: string; hosts: string[]; peers: ClusterPeer[]; }

export interface AggregateSource { source: string; count: number; ok: boolean; error?: string; }
export interface AggregateResp { total: number; count: number; sources: AggregateSource[]; accounts: AccountRow[]; }

export interface StartJobResp { jobId: string; accepted: number; engine?: string; resumedFrom?: string; }

// SSE 事件 payload(对照 job-runner publish)。
export interface WorkerUpdate { workerId: number; status?: string; stage?: string; account?: string; }
export interface RuntimeStats {
  browsersActive?: number; browsersMax?: number; browsersQueued?: number;
  jobRunning?: number; jobQueued?: number; jobDone?: number; jobTotal?: number;
  envTotal?: number; envInUse?: number; envBurned?: number;
}
export interface AccountSuccessEvt { rendered?: string; raw?: AccountRow; attempts?: number; }
export interface AccountFailedEvt {
  email?: string; password?: string; originalPassword?: string;
  reason?: string; stage?: string; failClass?: string; attempts?: number; detail?: string; rendered?: string;
}
export interface JobDoneEvt { jobId: string; total: number; success: number; failed: number; durationMs: number; failureStats?: { total: number; byClass: Record<string, number>; byReason: Record<string, number> }; }

// 运行历史 + 总览(期2)
export interface RunParams { mode?: string; concurrency?: number; count?: number; billingAction?: string; doApiKey?: boolean; doPasswordChange?: boolean; topUpAmount?: number; headed?: boolean; browserProvider?: string; engine?: string; doCard?: boolean; doPurchase?: boolean; solveHcaptcha?: string;
  // 配置快照:本次跑用的激活引擎预设/执行方案/高级参数(server.js handleApiRun 写入,可溯源)
  configSnapshot?: { advanced?: Record<string, unknown>; enginePresetId?: string | null; engineOpts?: Record<string, unknown> | null; schemeId?: string | null } | null; }
export interface RunSummary {
  jobId: string; nodeId: string; engine?: string; status: 'running' | 'finished' | 'error' | 'interrupted';
  startedAt: number; finishedAt: number | null; durationMs: number | null;
  total: number; success: number; failed: number; incomplete?: number; params: RunParams;
  failureStats?: { total: number; byClass: Record<string, number>; byReason: Record<string, number> } | null;
  error?: string | null;
  partial?: boolean; completenessPct?: number; // 结果对账:有结果但 <total(疑某分流组/子进程中途退出丢结果)
  resumedFrom?: string | null; // 续跑来源 jobId(普通提交为 null)
}
export interface RunsResp { nodeId: string; runs: RunSummary[]; }
export interface FailedRecord extends AccountFailedEvt { proxy?: string; createdAt?: string; purchaseStatus?: string; purchaseReason?: string; durationSec?: number | null; }
// 未完整/未运行号(第三桶):本批无结果且历史回填不到 → 逐号标原因(可只续跑这些)
export interface IncompleteRow { email: string; password?: string; status: 'banned' | 'bad-mailbox' | 'incomplete' | 'not-run'; reason: string; }
export interface RunDetailResp { jobId: string; summary: RunSummary | null; success: AccountRow[]; failed: FailedRecord[]; incomplete?: IncompleteRow[]; }
// 设置中心 + 健康(期4)
export interface ConfigView {
  config: {
    mailbox: { provider: string; apiBaseUrl: string; apiTimeoutMs: number; passwordChangeMode: string };
    captcha: { enabled: boolean; provider: string; solveTimeoutMs: number };
    cluster: { hosts: string[]; centralUrl: string; selfUrl: string };
    security: { gateStatic: boolean; allowIps: string[]; allowHosts: string[]; trustForwardedFor: boolean };
    adspower: { apiBase: string };
    secretsSet: Record<string, boolean>;
  };
  secrets: string[];
  note: string;
}

// 资源池(P1 后端)
export interface ProxyRow { id: string; host: string; port: number; user: string; passSet: boolean; type: 'http' | 'https' | 'socks5'; label: string; status: 'active' | 'disabled'; addedAt: number; lastTestedAt: number | null; lastOk: boolean | null; latencyMs: number | null; exitIp: string; failCount: number; }
export interface AddressRow { id: string; name: string; line1: string; city: string; state: string; zip: string; line2: string; country: string; status: 'active' | 'disabled'; addedAt: number; useCount: number; }
export interface AdsPowerEnv { id: string; label: string; endpoint?: string; status: 'active' | 'disabled'; addedAt: number; useCount: number; }
export interface AdsPowerEndpoint { id: string; label: string; apiBase: string; status: 'active' | 'disabled'; apiKeySet: boolean; lastOk: boolean | null; latencyMs: number | null; lastTestedAt: number | null; addedAt: number; }
export interface CaptchaKey { id: string; label: string; provider: string; status: 'active' | 'disabled'; usable: boolean; apiKeySet: boolean; balance: number | null; balanceAt: number | null; lastError: string; addedAt: number; }
export interface MailboxKey { id: string; label: string; provider: string; apiBaseUrl: string; status: 'active' | 'disabled'; apiKeySet: boolean; addedAt: number; }
export interface HealthInfo {
  nodeId: string; hostname: string; role: string; centralUrl: string;
  uptimeSec: number; version: string;
  peers: { nodeId: string; url: string; ageSec: number }[];
  storage: { resultFiles: number; resultsBytes: number; runsBytes: number };
  cardPool?: { total: number; active: number; disabled: number; exhausted: number; dispatched: number; remaining: number; available: number; todayConsumed: number; projectedDays: number | null } | null;
  config: { captchaKeySet: boolean; mailboxKeySet: boolean; tokenSet: boolean; captchaProvider: string; mailboxProvider: string; gateStatic: boolean };
  warnings: string[];
}

export interface SetupStep { key: string; group: 'secret' | 'pool'; required: boolean; label: string; done: boolean; detail: string; }
export interface SetupStatus { completed: boolean; dismissed: boolean; allRequiredDone: boolean; steps: SetupStep[]; }

export interface Overview {
  nodeId: string;
  runs: { total: number; finished: number; running: number; accSuccess: number; accFailed: number; accTotal: number; successRate: number; recent: RunSummary[] };
  cards: { total: number; available: number; exhausted: number; disabled: number };
  billing: { totalCharged: number; success: number; declined: number };
  errors: { total: number; topReasons: { code: string; n: number }[] };
  trend: { day: string; runs: number; success: number; failed: number }[];
}

// 环节命名策略预设(P2)
export interface StrategyPreset { id: string; name: string; builtin?: boolean; opts: Record<string, string | boolean>; }
export interface StageStrategy { activeId: string; presets: StrategyPreset[]; }
export interface StrategiesResp { version: number; stages: Record<string, StageStrategy>; }
// 失败恢复策略(单一全局命名空间 + 多预设)
export interface RecoveryPreset { id: string; name: string; builtin?: boolean; opts: Record<string, string | boolean>; }
export interface RecoveryGroup { activeId: string; presets: RecoveryPreset[]; }
export interface RecoveryResp { version: number; recovery: RecoveryGroup; }

// 失败分析(/api/analytics):漏斗 / 环节失败排名 / 智能分类+建议 / 资源战绩 / 错误分布 / 趋势。
export interface AnalyticsBucket { label: string; value: number; }
export interface AnalyticsEngine {
  engine: string; total: number; ok: number; fail: number; okRate: number;
  funnel: { key: number; card: number; bound: number; keyPct: number; cardPct: number; boundPct: number; diedAtCard: number };
  cardStates: AnalyticsBucket[];
}
export interface AnalyticsCategory { key: string; name: string; external: boolean; advice: string; count: number; pct: number; }
export interface AnalyticsProxyRow { host: string; attempts: number; bound: number; serverError: number; declined: number; boundPct: number; }
export interface AnalyticsCardRow { last4: string; attempts: number; bound: number; declined: number; boundPct: number; }
export interface AnalyticsResp {
  generatedAt: number; engine: string; sinceDays: number;
  combined: { total: number; ok: number; fail: number; okRate: number };
  engines: AnalyticsEngine[];
  blameByStage: AnalyticsBucket[];
  blameDetail: AnalyticsBucket[];
  byCategory: AnalyticsCategory[];
  summary: { totalFail: number; externalN: number; fixableN: number; externalPct: number; fixablePct: number };
  byProxy: AnalyticsProxyRow[];
  byCard: AnalyticsCardRow[];
  errorLog: { total: number; byStage: AnalyticsBucket[]; byReason: AnalyticsBucket[] };
  billing: { total: number; byResult: AnalyticsBucket[] };
  trend: { day: string; runs: number; success: number; failed: number }[];
}

// 引擎配置(per-engine 命名预设):每个引擎各存各的"怎么跑"配置,可多套预设。
export interface EnginePreset { id: string; name: string; builtin?: boolean; opts: Record<string, string | boolean>; }
export interface EngineGroup { activeId: string; presets: EnginePreset[]; }
export interface EngineConfigsResp { version: number; engines: Record<string, EngineGroup>; }
