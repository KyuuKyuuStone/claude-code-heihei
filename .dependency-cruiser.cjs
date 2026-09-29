/**
 * dependency-cruiser 分层门禁（v1.3.0 阶段4 · 7c）。
 *
 * L0-L4 单向依赖分层（高层可依赖低层，反向禁止）：
 *   L0 = 类型/工具（src/types/**, src/utils/**）
 *   L1 = 状态权威源（sessionRegistry + sessionEvents）——地基，零业务依赖
 *   L2 = 领域服务（src/server/services/** 其余）——conversationService /
 *        servantService / sessionService / dispatchMailboxService 等
 *   L3 = 编排投递（sessionMessenger）——可依 L2 及以下，不得反向
 *   L4 = 传输边界（src/server/ws/**, src/server/api/**）
 *
 * 每条规则 = 一个「禁止方向」的组合（dependency-cruiser 无原生层级比较）：
 *   - L0 → server 任何层
 *   - L1 → L2/L3/L4
 *   - L2 → L3/L4
 *   - L3 → L4
 *   - L4 传输边界内部 ws↔api 同层互依
 *
 * 动态 import 断环禁令：src/server/services/** 内相对路径的 await import()
 * 禁止（断环一律走注入点/事件订阅/函数迁移），白名单 = conversationService
 * 对 heiheiOAuthService 的延迟加载 + 测试文件。
 *
 * 运行：bun run lint:layers（= depcruise，红绿验证见阶段4汇报）。
 */

const L0 = '^src/(types|utils)/'
const L1 = '^src/server/services/(sessionRegistry|sessionEvents)\\.ts$'
const L2 = '^src/server/services/(?!sessionRegistry|sessionEvents|sessionMessenger)'
const L3 = '^src/server/services/sessionMessenger\\.ts$'
const L4 = '^src/server/(ws|api)/'

/** 测试文件豁免（单测允许自由组织依赖） */
const TEST = ['\\.test\\.ts$', '__tests__']

module.exports = {
  forbidden: [
    // ── 环检测：src/server 协作核心域不新增循环 ─────────────────────
    // 7a/7b 已断的静态环（conversationService⇄servantService、
    // sessionMessenger→ws/handler）与本批 R2b 断的
    // conversationService→notifier→sessionMessenger→conversationService
    // 静态环不得回归；no-circular 仍有存量（动态 import 成对成环：
    // conversationService⇄servantIncidentNotifier 等，及 heiheiOpenAIOAuthService /
    // grokOfficialProvider / computerUseApprovalService 的既有环）——
    // 属既有接法，收敛需进一步注入缝改造，已另立条目暂缓，由 baseline
    // 冻结、门禁只拦新增。
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'v1.3.0 阶段4 + v1.3.1 R2b：静态环已断的不许回归；动态 import 既有环存量冻结在 baseline，新增环一律拦截',
      from: { path: '^src/server/' },
      to: { circular: true },
    },

    // ── L0 → server 任何层 ───────────────────────────────────────────
    {
      name: 'layer-L0-no-server-deps',
      severity: 'error',
      comment: 'L0（类型/工具）不得依赖 server 层',
      from: { path: L0, pathNot: TEST },
      to: { path: '^src/server/' },
    },

    // ── L1 → L2/L3/L4 ───────────────────────────────────────────────
    {
      name: 'layer-L1-no-upward',
      severity: 'error',
      comment: 'L1（registry/events 状态权威源）只依赖自身，不得触及领域服务/编排/传输层',
      from: { path: L1, pathNot: TEST },
      to: { path: [L2, L3, L4] },
    },

    // ── L2 → L3/L4 ──────────────────────────────────────────────────
    {
      name: 'layer-L2-no-upward',
      severity: 'error',
      comment: 'L2 领域服务不得依赖编排投递（L3）与传输边界（L4）——断环经注入点/事件总线',
      from: { path: L2, pathNot: TEST },
      to: { path: [L3, L4] },
    },

    // ── L3 → L4 ─────────────────────────────────────────────────────
    {
      name: 'layer-L3-no-upward',
      severity: 'error',
      comment: 'L3 编排投递（sessionMessenger）不得依赖传输边界（7b：rebind 经事件订阅自触发）',
      from: { path: L3, pathNot: TEST },
      to: { path: L4 },
    },

    // ── L4 同层：api 内部互依禁令 ────────────────────────────────────
    {
      name: 'layer-L4-no-same-layer',
      severity: 'error',
      comment: 'L4 传输边界内 api/* 禁止互相依赖（ws/handler 是汇聚点例外，见 pathNot）',
      from: { path: '^src/server/api/(?!sessions\\.ts$)', pathNot: TEST },
      to: { path: '^src/server/api/' },
    },

    // ── 动态 import 断环禁令（services 层）────────────────────────────
    {
      name: 'no-dynamic-import-in-services',
      severity: 'error',
      comment:
        'src/server/services/** 禁止相对路径动态 import 断环（7a/7b 已改为注入点/事件订阅/函数迁移）。白名单：conversationService 对 heiheiOAuthService 的延迟加载 + 测试文件。',
      from: {
        path: '^src/server/services/',
        pathNot: ['\\.test\\.ts$', '__tests__'],
      },
      to: {
        dependencyTypes: ['dynamic-import'],
        path: '^src/',
        pathNot: ['heiheiOAuthService'],
      },
    },
  ],

  options: {
    doNotFollow: { path: ['node_modules'] },
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      extensions: ['.ts', '.js', '.cjs', '.mjs'],
    },
    // v1.3.0 阶段4 · 7c（v1.3.1 · R2a 修订）：存量违规冻结与门禁运行经 CLI 参数
    // （bun run lint:layers）：
    //   node node_modules/dependency-cruiser/bin/dependency-cruiser.mjs src \
    //     --config .dependency-cruiser.cjs --ignore-known
    // 存量冻结在 .dependency-cruiser-known-violations.json（条数以该文件为准，
    // 不在此硬编码——v1.3.1 R2b 断环后已从入册时的旧值刷新收敛）。门禁只拦
    // 新增——消化存量后重新生成：同命令加 --output-type baseline 重定向覆盖。
  },
}
