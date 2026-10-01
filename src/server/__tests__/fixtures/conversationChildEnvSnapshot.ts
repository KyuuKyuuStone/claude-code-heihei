/**
 * conversationService.buildChildEnv 的「三种身份环境快照」fixture（规格 + 数据）。
 *
 * ── 这份文件是干什么的 ────────────────────────────────────────────────
 * 为 conversationService 结构拆分**第③批**（childEnv / collabIdentity）准备
 * 的行为基线。第③批要保证：拆分前后，主管 / 员工 / 普通会话三种身份注入给
 * CLI 子进程的 env **键集合与取值都不变**。fixture 必须在拆分**之前**写好，
 * 否则旧行为无法重建（架构决策《结构拆分边界》补充裁决四·第四节）。
 *
 * ── 现状 ──────────────────────────────────────────────────────────────
 * 本文件与同目录的 `conversationChildEnvSnapshot.md` **只写不跑**：
 * 用户机器频繁死机，一切运行型验证（bun test / vitest / tsc / lint）已停。
 * 本 fixture **从未被执行过**，它是规格文档，不是已验证的断言。
 *
 * ── 来源（行号以 v1.6.1 / 258ed0a 为准） ──────────────────────────────
 * · buildChildEnv ............ conversationService.ts:1821-2070
 * · isRegisteredSupervisor ... conversationService.ts:1761-1801
 * · getCollabIdentity ........ conversationService.ts:1803-1811（直接转调上一个）
 * · isServantNonInteractiveEnabled ... conversationService.ts:90-92
 * · CO..._ENV 常量 ........... collaboration/ 下导出
 */

/** 花名册条目中与 env 注入相关的字段（对应 ServantEntry 的子集） */
export type RosterEntryFixture = {
  supervisor?: boolean
  enabled?: boolean
  constraint?: 'readonly' | 'whitelist'
  writeDirs?: string[]
}

export type ChildEnvIdentityFixture = {
  name: 'supervisor' | 'servant' | 'plain'
  /** 该身份在花名册里的样子（plain 会话不在册 → null） */
  rosterEntry: RosterEntryFixture | null
  /** 用例里额外需要固定的输入 */
  inputs: {
    /** CC_HEIHEI_SESSION_ID 是否注入（取决于调用方是否传 sessionId） */
    sessionId: string | null
  }
  /** 必须**存在**且取值恒定的键 */
  expectPresent: Record<string, string>
  /** 必须**不存在**的键（身份隔离的核心断言） */
  expectAbsent: string[]
}

/**
 * 三种身份的期望值。
 *
 * 规则出处逐条对应 buildChildEnv 的花括号展开式（:2000-2035）。
 * 「必须不存在」的语义很重要：普通会话**零变化**是设计目标
 * （v1.6.0 契约 §三：普通会话不注入任何协作身份标记）。
 */
export const CHILD_ENV_IDENTITY_FIXTURES: ChildEnvIdentityFixture[] = [
  {
    name: 'supervisor',
    rosterEntry: { supervisor: true, enabled: true },
    inputs: { sessionId: 'sess-supervisor' },
    expectPresent: {
      // :2000 所有身份只要有 sessionId 就注入
      CC_HEIHEI_SESSION_ID: 'sess-supervisor',
      // :2004 主管标记
      CC_HEIHEI_SUPERVISOR: '1',
      // :2008-2012 显式协作身份：主管 → supervisor
      CC_HEIHEI_COLLAB_ROLE: 'supervisor',
      // :2017 A7：在册协作会话（含主管）不注入 computer-use
      CLAUDE_COMPUTER_USE_ENABLED: '0',
    },
    expectAbsent: [
      // :2021-2025 只对 servant 注入；主管的 AskUserQuestion 是唯一升级出口，必须可用
      'CC_HEIHEI_SERVANT_NONINTERACTIVE',
      'CC_HEIHEI_SERVANT_CONSTRAINT',
      'CC_HEIHEI_SERVANT_WRITE_DIRS',
    ],
  },
  {
    name: 'servant',
    rosterEntry: { supervisor: false, enabled: true },
    inputs: { sessionId: 'sess-servant' },
    expectPresent: {
      CC_HEIHEI_SESSION_ID: 'sess-servant',
      CC_HEIHEI_COLLAB_ROLE: 'servant',
      CLAUDE_COMPUTER_USE_ENABLED: '0',
      // :2021-2025 免审批兜底开关，默认开；isServantNonInteractiveEnabled() 读
      // 进程环境，若外部显式置 0 则为 '0'（快照测试需固定这个输入）
      CC_HEIHEI_SERVANT_NONINTERACTIVE: '1',
    },
    expectAbsent: [
      // 非主管，不得有主管标记
      'CC_HEIHEI_SUPERVISOR',
      // 无 constraint 时不注入档位键
      'CC_HEIHEI_SERVANT_CONSTRAINT',
      'CC_HEIHEI_SERVANT_WRITE_DIRS',
    ],
  },
  {
    name: 'plain',
    rosterEntry: null,
    inputs: { sessionId: 'sess-plain' },
    expectPresent: {
      CC_HEIHEI_SESSION_ID: 'sess-plain',
    },
    expectAbsent: [
      // v1.6.0 契约 §三：非协作会话与用户会话**不注入**，普通会话零变化
      'CC_HEIHEI_SUPERVISOR',
      'CC_HEIHEI_COLLAB_ROLE',
      'CLAUDE_COMPUTER_USE_ENABLED',
      'CC_HEIHEI_SERVANT_NONINTERACTIVE',
      'CC_HEIHEI_SERVANT_CONSTRAINT',
      'CC_HEIHEI_SERVANT_WRITE_DIRS',
    ],
  },
]

/**
 * 员工档位的两个变体（constraint 只会是 readonly / whitelist 之一，
 * 取值为其它字符串时按**不注入档位键**处理，见 :1789-1794 的守卫）。
 */
export const CHILD_ENV_CONSTRAINT_FIXTURES: Array<{
  constraint: 'readonly' | 'whitelist' | undefined
  writeDirs?: string[]
  expectPresent: Record<string, string>
  expectAbsent: string[]
}> = [
  {
    constraint: 'readonly',
    expectPresent: { CC_HEIHEI_SERVANT_CONSTRAINT: 'readonly' },
    expectAbsent: ['CC_HEIHEI_SERVANT_WRITE_DIRS'],
  },
  {
    constraint: 'whitelist',
    writeDirs: ['D:/a', 'D:/b'],
    expectPresent: {
      CC_HEIHEI_SERVANT_CONSTRAINT: 'whitelist',
      // :2033 用 \n 连接；**缺列表时注入空串**（guard 解析为空 → 全拒，最严格解释）
      CC_HEIHEI_SERVANT_WRITE_DIRS: 'D:/a\nD:/b',
    },
    expectAbsent: [],
  },
  {
    constraint: 'whitelist',
    writeDirs: undefined,
    expectPresent: {
      CC_HEIHEI_SERVANT_CONSTRAINT: 'whitelist',
      // 关键边界：白名单为空 → 注入空串而不是省略键
      CC_HEIHEI_SERVANT_WRITE_DIRS: '',
    },
    expectAbsent: [],
  },
]

/**
 * 与身份**无关**的固定注入。三种身份都必须有，且值不随身份变化
 * （工作目录类取自入参 workDir）。
 *
 * 注意 `?` 表示值依赖外部输入或进程环境，快照测试需要固定这些输入后再比较。
 */
export const CHILD_ENV_FIXED_KEYS: Array<{
  key: string
  /** 固定值；null 表示「取决于入参/进程环境」 */
  value: string | null
  /** 代码位置 */
  at: string
}> = [
  { key: 'CLAUDE_CODE_ENABLE_TASKS', value: '1', at: ':1926' },
  { key: 'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING', value: '1', at: ':1927' },
  { key: 'CLAUDE_ENABLE_STREAM_WATCHDOG', value: null, at: ':1929（cleanEnv 优先，缺省 1）' },
  { key: 'CLAUDE_STREAM_IDLE_TIMEOUT_MS', value: null, at: ':1934（缺省 240000）' },
  { key: 'CLAUDE_STREAM_MAX_DURATION_MS', value: null, at: ':1944-1948（本地 baseUrl→1800000，否则 600000）' },
  { key: 'CLAUDE_STREAM_FIRST_TOKEN_TIMEOUT_MS', value: null, at: ':1956（缺省取 networkEnv.API_TIMEOUT_MS）' },
  { key: 'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK', value: null, at: ':1964（缺省 1）' },
  { key: 'CLAUDE_COWORK_MEMORY_PATH_OVERRIDE', value: null, at: ':1966（由 workDir 派生）' },
  { key: 'CALLER_DIR', value: null, at: ':1967（= workDir）' },
  { key: 'PWD', value: null, at: ':1968（= workDir）' },
  { key: 'CC_HEIHEI_WORK_DIR', value: null, at: ':1975（= workDir）' },
  { key: 'CC_HEIHEI_SKIP_DOTENV', value: '1', at: ':2045' },
  { key: 'CC_HEIHEI_TRANSCRIPT_ENTRYPOINT', value: 'claude-desktop', at: ':2048' },
]

/**
 * 与身份无关的**条件**注入。快照测试要把这些条件固定在某个取值上，
 * 否则同一个身份会有多组合法输出。
 */
export const CHILD_ENV_CONDITIONAL_RULES: Array<{
  key: string
  condition: string
  at: string
}> = [
  { key: 'CLAUDE_CODE_DIAGNOSTICS_FILE', condition: '诊断目录准备成功', at: ':1965' },
  { key: 'CLAUDE_CODE_EAGER_FLUSH', condition: '有 sdkUrl（缺省 1）', at: ':1981' },
  { key: 'CC_HEIHEI_COMPUTER_USE_HOST_BUNDLE_ID', condition: '有 sdkUrl', at: ':1982' },
  { key: 'CC_HEIHEI_TRACE_API_CALLS', condition: '有 sdkUrl 且 trace 抓取开启', at: ':1986' },
  { key: 'CC_HEIHEI_TRACE_PROVIDER_ID / _NAME / _FORMAT', condition: '上一条 + 有显式 provider', at: ':1990-1992' },
  { key: 'CC_HEIHEI_DESKTOP_SERVER_URL', condition: 'sdkUrl 可解析出 host', at: ':1996' },
  { key: 'CC_HEIHEI_DESKTOP_AWAIT_MCP / _TIMEOUT_MS', condition: '有 sdkUrl（超时固定 5000）', at: ':2038-2039' },
  { key: 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', condition: '有显式 provider 运行时 env', at: ':2050' },
  { key: '...explicitProviderEnv', condition: '有显式 provider（整体展开）', at: ':2057' },
  { key: 'OPENAI_CODEX_REASONING_EFFORT 等', condition: 'OpenAI 官方 provider + 合法 effort', at: ':2059-2062' },
  { key: '...networkEnv', condition: '网络设置展开（总是）', at: ':2064' },
  { key: '...buildOfficialOAuthEnv()', condition: 'shouldMarkManagedOAuth(providerId)', at: ':2065-2067' },
  { key: '...attributionHeaderEnv', condition: '总是（值随 model 变化）', at: ':2068' },
]

/**
 * 身份判定真值表（isRegisteredSupervisor，:1782-1795）。
 * 这是三种身份 fixture 的**依据**，第③批拆分 collabIdentity 时逐行比对。
 */
export const COLLAB_IDENTITY_TRUTH_TABLE: Array<{
  roster: 'absent' | 'supervisor' | 'servant' | 'servant-disabled'
  supervisor: boolean
  registered: boolean
  servant: boolean
}> = [
  // entry === null（不在册，含花名册读取异常降级）
  { roster: 'absent', supervisor: false, registered: false, servant: false },
  { roster: 'supervisor', supervisor: true, registered: true, servant: false },
  // enabled === false 时不算员工（契约 §3.1：enabled && !supervisor）
  { roster: 'servant', supervisor: false, registered: true, servant: true },
  { roster: 'servant-disabled', supervisor: false, registered: true, servant: false },
]
