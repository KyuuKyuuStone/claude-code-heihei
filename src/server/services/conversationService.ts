/**
 * ConversationService — CLI subprocess manager
 *
 * Each desktop session owns one CLI subprocess. The subprocess talks back to
 * the desktop server over the SDK WebSocket bridge, while the desktop UI talks
 * to the server over its own client WebSocket.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ProviderService } from './providerService.js'
import { appendRosterDigestIfSupervisor } from './rosterDigest.js'
import {
  OPENAI_CODEX_OAUTH_FILE_ENV_KEY,
  OPENAI_OAUTH_PROVIDER_ENV_KEY,
  isOpenAIOfficialProviderId,
} from './openaiOfficialProvider.js'
import {
  GROK_OAUTH_FILE_ENV_KEY,
  GROK_OAUTH_PROVIDER_ENV_KEY,
} from './grokOfficialProvider.js'
import {
  OPENAI_CODEX_REASONING_EFFORT_ENV_KEY,
  isOpenAIReasoningEffort,
} from '../../services/openaiAuth/models.js'
import { sessionService } from './sessionService.js'
import { diagnosticsService } from './diagnosticsService.js'
import {
  isMaterializedWorktreeLaunch,
  prepareSessionWorkspace,
  shouldCreateWorktreeForSessionLaunch,
  type PreparedSessionWorkspace,
} from './repositoryLaunchService.js'
import {
  buildClaudeCliArgs,
  resolveClaudeCliLauncher,
} from '../../utils/desktopBundledCli.js'
import {
  ASK_USER_QUESTION_CLARIFY_MESSAGE,
  ASK_USER_QUESTION_CLARIFY_WITH_QUESTIONS_PREFIX,
  PLAN_REJECTION_MESSAGE,
  PLAN_REJECTION_WITH_REASON_PREFIX,
  REJECT_MESSAGE,
  REJECT_MESSAGE_WITH_REASON_PREFIX,
} from '../../constants/messages.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { findCanonicalGitRoot } from '../../utils/git.js'
import { sanitizePath } from '../../utils/path.js'
import { getProcessEnvWithTerminalShellEnvironment } from '../../utils/terminalShellEnvironment.js'
import { attributionHeaderEnvForModel } from './attributionHeaderPolicy.js'
import {
  buildNetworkEnvironment,
  loadNetworkSettings,
  SYSTEM_PROXY_URL_ENV,
  type NetworkSettings,
} from './networkSettings.js'
import { readTraceCaptureSettings } from './traceCaptureService.js'
import { observeSessionSdkMessage } from './dispatchReceiptService.js'
// v1.3.0 阶段4 · 7a：花名册查询依赖注入点（断 conversationService ⇄ servantService 环）
import { getServantEntry } from './servantInfoSource.js'
import {
  clearSession,
  dropActiveTurn,
  getSessionSnapshot,
  markCrashed,
  markStarting,
  markStopped,
  registerSession,
  setAwaitingPermission,
  isSessionClientAttached,
  tombstoneSession,
} from './sessionRegistry.js'
// v1.7 结构拆分第①批：logError 与 imageResizer 的两个工具函数随附件子系统
// 一起搬到了 conversation/attachments.ts，本文件不再使用它们。
import {
  COLLAB_SERVANT_NONINTERACTIVE_ENV,
  COLLAB_SERVANT_PERMISSION_DENIED_MESSAGE,
} from '../../collaboration/collabToolContract.js'
// v1.7 结构拆分第①批（纯移动）：诊断文本与附件落盘搬到 conversation/ 子目录，
// 门面以原路径重导出，方法走类字段委托（`this.xxx(...)` 调用点一行未改）。
import {
  MAX_CAPTURED_PROCESS_LINES,
  MAX_CAPTURED_SDK_MESSAGES,
  MAX_CAPTURED_SDK_DIAGNOSTIC_TEXT_BYTES,
  MAX_CAPTURED_SDK_MESSAGE_BYTES,
  MAX_CAPTURED_SDK_TOTAL_BYTES,
  extractAssistantApiErrorDetail,
  extractAssistantText,
  extractSdkErrorEvent,
  extractStartupDetail,
  isAssistantApiErrorMessage,
  isSafeSdkStatus,
  redactProcessOutput,
  sdkErrorCategory,
  summarizeSdkMessages,
} from './conversation/startupDiagnostics.js'
import {
  buildUserContent,
  getAttachmentExtension,
  materializeAttachments,
  materializeImageAttachment,
  normalizeImageExtension,
  parseAttachmentData,
  readImageAttachmentPayload,
  replaceFileExtension,
  sanitizeAttachmentName,
  shouldInlineImageAttachment,
  writeUploadAttachment,
  type AttachmentRef,
} from './conversation/attachments.js'
// v1.7 结构拆分第②批（纯移动）：CLI 参数构造。SessionStartOptions 是这两个
// 函数的必需参数类型（原是门面本地未导出类型），随本批一起搬；门面导出面不变。
import {
  getPermissionArgs,
  getRuntimeArgs,
  type SessionStartOptions,
} from './conversation/cliArgs.js'
import { completeSdkStartupConfirmation } from './conversation/sdkStartupConfirmation.js'
import {
  armPermissionTimeout,
  buildPendingPermissionRecord,
  clearAllPermissionTimeouts,
  clearPermissionTimeout,
  extendPermissionTimeoutsForClient,
  handleCanUseToolRequest,
  PERMISSION_TIMEOUT_DENY_MESSAGE,
  type PendingPermission,
  type PermissionTimeoutDeps,
} from './conversation/permissionTimeout.js'
export { MAX_CAPTURED_SDK_MESSAGE_BYTES, MAX_CAPTURED_SDK_TOTAL_BYTES }

/**
 * v1.6.1（契约 §3.6）：员工会话免审批兜底总开关，默认开；置 '0' 关闭自动拒绝
 * 与 CLI 侧的工具裁剪。只控「自动拒绝」——强制 bypass 是既定语义的收口，不设开关。
 * 服务端与 CLI 子进程读同一个环境变量（子进程继承）。
 */
export function isServantNonInteractiveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[COLLAB_SERVANT_NONINTERACTIVE_ENV] !== '0'
}

// v1.7 结构拆分第①批：抓取/诊断常量搬到 conversation/startupDiagnostics.ts，
// 由顶部 import 提供；两个原本 export 的常量在本文件重导出，导出面不变。
const CONTROL_READY_POLL_MS = 50
/**
 * 记住多少条已处理的 SDK 消息 uuid，用来挡掉 CLI 重连时的重放。
 * CLI 侧重放缓冲是 DEFAULT_MAX_BUFFER_SIZE = 1000 条
 * （src/cli/transports/WebSocketTransport.ts），这里留一倍余量，
 * 保证整个缓冲区被重放时每一条都还认得出来。
 */
const MAX_SEEN_SDK_MESSAGE_UUIDS = 2_000
const AUTO_MEMORY_DIRNAME = 'memory'
export const DESKTOP_CLI_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 6_000

// 缺陷修复 B（拉起链路总超时）：startSession 各子步骤各自限时，但整条链路原本没有
// 总预算，长尾可累计到分钟级（已观测 82s / >150s）。此处只加**最外层一层**包装。
// 取 180s：不低于观测分布上沿，保证分布内的成功路径零变化；取该下限值而非更大值，
// 是为了把「截断慢但最终能成功的长尾」这一行为变更压到最小。
const STARTUP_TOTAL_BUDGET_MS = 180_000

/**
 * Severity for a CLI subprocess exit, by exit code.
 *
 * Reaching handleProcessExit already means the process left outside the clean
 * stop path, but the exit code still tells crash from teardown:
 *  - 0            clean exit
 *  - null         terminated by a signal with no numeric code
 *  - 143 (SIGTERM), 137 (SIGKILL): killed — shutdown / user stop / OS reclaim
 * None of these are a crash the user needs flagged in red. Any other non-zero
 * code is a genuine "it died mid-chat" failure and stays an error.
 */
export function cliExitSeverity(code: number | null): 'info' | 'error' {
  if (code === 0 || code === null || code === 143 || code === 137) return 'info'
  return 'error'
}

/**
 * Builds the denial text the CLI hands to the model as tool_result content.
 *
 * The model reads this verbatim, so it has to carry the instruction the desktop
 * UI can't: a plain tool denial means "stop and wait for me", a rejected plan
 * means "keep planning", and a question the user wants to talk over means "ask
 * them what needs clarifying". Both plan renderers (the CLI's
 * renderToolUseRejectedMessage, the desktop's extractPlanPreview) read the plan
 * from the tool input, so nothing here needs to echo the plan back.
 */
export function buildDenyMessage(
  toolName: string | undefined,
  denyMessage: string | undefined,
): string {
  const feedback = denyMessage?.trim()
  if (toolName === 'ExitPlanMode') {
    return feedback
      ? `${PLAN_REJECTION_WITH_REASON_PREFIX}${feedback}`
      : PLAN_REJECTION_MESSAGE
  }
  // "Chat about this" is a denial only in transport terms — the user wants to
  // keep talking, not to stop the turn. REJECT_MESSAGE's "STOP and wait" would
  // contradict that and leave them staring at a silent turn.
  if (toolName === 'AskUserQuestion') {
    return feedback
      ? `${ASK_USER_QUESTION_CLARIFY_WITH_QUESTIONS_PREFIX}${feedback}`
      : ASK_USER_QUESTION_CLARIFY_MESSAGE
  }
  return feedback
    ? `${REJECT_MESSAGE_WITH_REASON_PREFIX}${feedback}`
    : REJECT_MESSAGE
}

export function buildConversationCliSpawnOptions(
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  return {
    cwd,
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  } as const
}

// v1.7 结构拆分第①批：AttachmentRef 等附件类型搬到 conversation/attachments.ts，
// 本文件仍要用的 AttachmentRef 由顶部 import 提供（无需给本地类型加 export）。
type SessionOutputCallback = (msg: any) => void

function networkRoutingFingerprint(
  settings: NetworkSettings,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return JSON.stringify({
    timeoutMs: settings.aiRequestTimeoutMs,
    proxyMode: settings.proxy.mode,
    manualProxyUrl: settings.proxy.mode === 'manual' ? settings.proxy.url.trim() : '',
    systemProxyUrl:
      settings.proxy.mode === 'system'
        ? env[SYSTEM_PROXY_URL_ENV]?.trim() || ''
        : '',
    noProxy: env.no_proxy || env.NO_PROXY || '',
  })
}

type SessionProcess = {
  proc: ReturnType<typeof Bun.spawn>
  outputCallbacks: SessionOutputCallback[]
  workDir: string
  permissionMode: string
  networkRoutingFingerprint: string
  networkDerivedFirstTokenTimeout: boolean
  sdkToken: string
  sdkSocket: { send(data: string): void } | null
  sdkAttached: Promise<void>
  resolveSdkAttached: (() => void) | null
  pendingOutbound: string[]
  startupPending: boolean
  startupExitCode: number | null
  stdoutLines: string[]
  stderrLines: string[]
  outputDrain: Promise<void>
  /**
   * UUID 的 SDK 消息一旦处理过就记在这里，用于挡掉 CLI 重连时的整轮重放。
   * 详见 handleSdkPayload 里的说明。插入顺序即淘汰顺序（Set 保序）。
   */
  seenSdkMessageUuids: Set<string>
  sdkMessages: any[]
  sdkMessageBytes?: number
  initMessage: any | null
  usesOfficialOAuth: boolean
  officialOAuthToken: string | null
  pendingPermissionRequests: Map<string, PendingPermission>
  /**
   * v1.6.1：本会话是不是「员工」（花名册在册且非主管）。拉起时按花名册定格，
   * 用于 can_use_tool 自动拒绝——员工不得停在等用户点击。主管一律 false。
   */
  servantNonInteractive: boolean
}

/** P0-b：值类型（含超时计时器）搬到 conversation/permissionTimeout.ts；门面导出名不变。 */
export type PendingPermissionRequest = PendingPermission & { requestId: string }

// v1.7 结构拆分第②批：SessionStartOptions 搬到 conversation/cliArgs.ts，
// 本文件改为从那里 import（类型仍不对外导出，门面导出面不变）。

export class ConversationStartupError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'WORKDIR_INVALID'
      | 'CLI_AUTH_REQUIRED'
      | 'CLI_SESSION_CONFLICT'
      | 'CLI_START_FAILED'
      | 'CLI_SPAWN_FAILED'
      | 'SESSION_DELETED'
      | 'STARTUP_TIMEOUT',
    readonly retryable = false,
    /** 触发启动失败的 CLI 退出码；用于把 SIGTERM/SIGKILL 类回收与真崩溃区分开 */
    readonly exitCode?: number,
  ) {
    super(message)
    this.name = 'ConversationStartupError'
  }
}

export class ConversationService {
  private sessions = new Map<string, SessionProcess>()
  // v1.3.0 阶段3：软删除标记迁移至 sessionRegistry 的 tombstone 机制
  // （markSessionDeleted → tombstoneSession；unmarkSessionDeleted → registerSession
  // 恢复），deletedSessions Set 本体删除。守卫语义由快照 phase==='deleted' 承接。
  private providerService = new ProviderService()
  private pendingPermissionModeChanges = new Map<string, Map<string, number>>()

  private trackPendingPermissionModeChange(sessionId: string, mode: string, delta: 1 | -1): void {
    const sessionChanges = this.pendingPermissionModeChanges.get(sessionId) ?? new Map<string, number>()
    const nextCount = (sessionChanges.get(mode) ?? 0) + delta
    if (nextCount > 0) {
      sessionChanges.set(mode, nextCount)
      this.pendingPermissionModeChanges.set(sessionId, sessionChanges)
      return
    }
    sessionChanges.delete(mode)
    if (sessionChanges.size === 0) {
      this.pendingPermissionModeChanges.delete(sessionId)
    }
  }

  isPermissionModeChangePending(sessionId: string, mode: string): boolean {
    return (this.pendingPermissionModeChanges.get(sessionId)?.get(mode) ?? 0) > 0
  }

  private buildSessionCliArgs(
    sessionId: string,
    sdkUrl: string,
    shouldResume: boolean,
    options?: SessionStartOptions,
    repository?: PreparedSessionWorkspace['repository'],
    /** v1.6.1：员工会话（在册且非主管）→ 强制 bypass，见 getPermissionArgs */
    servantNonInteractive = false,
  ): string[] {
    const dangerousMode = process.env.CLAUDE_DANGEROUS_MODE === '1'
    const worktreeArgs =
      !shouldResume && repository?.worktree
        ? [
            '--worktree',
            repository.worktreeSlug || repository.worktreeBranch || repository.branch,
            '--worktree-base-ref',
            repository.baseRef,
          ]
        : []

    return this.resolveCliArgs([
      '--print',
      '--verbose',
      '--sdk-url',
      sdkUrl,
      '--enable-auth-status',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      // Desktop chat depends on partial assistant deltas; without this the
      // server only sees the completed assistant message at turn end.
      '--include-partial-messages',
      ...(shouldResume ? ['--resume', sessionId] : ['--session-id', sessionId]),
      ...worktreeArgs,
      '--replay-user-messages',
      ...this.getRuntimeArgs(options),
      ...this.getPermissionArgs(options?.permissionMode, dangerousMode, servantNonInteractive),
    ])
  }

  /**
   * 缺陷修复 B：拉起链路总超时（最外层一层包装）。
   * 超时只放弃**等待**，不打断、不清理内部链路——内部仍按原有路径继续跑完，
   * 失败时仍由原有的 ConversationStartupError / markCrashed 收尾。
   */
  async startSession(
    sessionId: string,
    workDir: string,
    sdkUrl: string,
    options?: SessionStartOptions,
  ): Promise<void> {
    const internal = this.startSessionInternal(sessionId, workDir, sdkUrl, options)
    // 超时后不再观察 internal，但它仍在跑；接管其后续拒绝，避免 unhandledRejection。
    // （非清理逻辑：不触碰子步骤、不改变其生命周期。）
    internal.catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        internal,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new ConversationStartupError(
                  `Session startup exceeded ${STARTUP_TOTAL_BUDGET_MS}ms budget: ${sessionId}`,
                  'STARTUP_TIMEOUT',
                  true,
                ),
              ),
            STARTUP_TOTAL_BUDGET_MS,
          )
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private async startSessionInternal(
    sessionId: string,
    workDir: string,
    sdkUrl: string,
    options?: SessionStartOptions,
  ): Promise<void> {
    // 阶段3：tombstone 守卫（registry 快照）——软删除会话不得复活。
    // 必须在 registerSession 之前拦（registerSession 对 deleted 条目 = 恢复迁移）。
    if (getSessionSnapshot(sessionId)?.phase === 'deleted') {
      throw new ConversationStartupError(
        `Session was deleted before startup completed: ${sessionId}`,
        'SESSION_DELETED',
      )
    }
    // 防重复拉起守卫（阶段2 · 5d 修订，阶段4 全量质检修复）：条目保留设计下
    // stopped/crashed 条目仍在 sessions map（元数据留待显式决策），重启是方案
    // 的合法路径（crashed→starting / stopped→starting）——只有活跃进程
    // （starting/running）才阻断重复拉起。与 handler 防重复拉起守卫同语义。
    if (this.hasSession(sessionId)) return

    const launchInfo = await sessionService.getSessionLaunchInfo(sessionId)
    const shouldResume = !!launchInfo && launchInfo.transcriptMessageCount > 0
    const shouldReplacePlaceholder =
      !!launchInfo && launchInfo.transcriptMessageCount === 0
    const shouldCreateWorktree =
      !!launchInfo && shouldCreateWorktreeForSessionLaunch(launchInfo)
    const hasMaterializedWorktree =
      !!launchInfo && isMaterializedWorktreeLaunch(launchInfo)

    // 阶段3：二次 tombstone 守卫（startSession await 期间被删除的竞态防复活）
    if (getSessionSnapshot(sessionId)?.phase === 'deleted') {
      throw new ConversationStartupError(
        `Session was deleted before startup completed: ${sessionId}`,
        'SESSION_DELETED',
      )
    }

    if (!fs.existsSync(workDir) || !fs.statSync(workDir).isDirectory()) {
      throw new ConversationStartupError(
        `Working directory does not exist or is not a directory: ${workDir}`,
        'WORKDIR_INVALID',
      )
    }

    if (shouldReplacePlaceholder) {
      await sessionService.clearSessionTranscript(sessionId, workDir)
    }

    let launchWorkDir = workDir
    let launchRepository = launchInfo?.repository
    if (shouldCreateWorktree && launchRepository?.worktree) {
      launchWorkDir = launchRepository.requestedWorkDir || launchRepository.repoRoot || workDir
    } else if (!shouldResume && launchRepository && !hasMaterializedWorktree) {
      const preparedWorkspace = await prepareSessionWorkspace(
        workDir,
        {
          branch: launchRepository.branch,
          worktree: false,
        },
        sessionId,
      )
      launchWorkDir = preparedWorkspace.workDir
      launchRepository = preparedWorkspace.repository
    }

    if (!shouldCreateWorktree && launchRepository?.worktree) {
      launchRepository = {
        ...launchRepository,
        worktree: false,
      }
    }

    if (!fs.existsSync(launchWorkDir) || !fs.statSync(launchWorkDir).isDirectory()) {
      throw new ConversationStartupError(
        `Working directory does not exist or is not a directory: ${launchWorkDir}`,
        'WORKDIR_INVALID',
      )
    }

    // v1.6.1：员工会话强制免审批。身份取一次，既用于 CLI 参数，也定格到 session
    // 供 can_use_tool 自动拒绝使用（契约 §3.3 第 1、3 条）。
    const collabIdentityForStart = await this.getCollabIdentity(sessionId)
    const servantNonInteractive = collabIdentityForStart.servant

    const args = this.buildSessionCliArgs(
      sessionId,
      sdkUrl,
      shouldResume,
      options,
      launchRepository,
      servantNonInteractive,
    )

    console.log(
      `[ConversationService] Starting CLI for ${sessionId}, cwd: ${launchWorkDir} (process.cwd()=${process.cwd()}, CALLER_DIR will be pinned to workDir)`,
    )

    // IMPORTANT (Bug#5): 必须覆盖子进程继承的 CALLER_DIR / PWD。
    // preload.ts 顶层读 process.env.CALLER_DIR 并调用 process.chdir(CALLER_DIR)。
    // 在 bundled 桌面端里，server sidecar 被 Tauri 从 cwd=/ 启动，claude-sidecar.ts
    // 在 server/cli 模式入口把 CALLER_DIR 默认设成 process.cwd()（即 '/'），
    // 随后这个 env 被完整继承到 Bun.spawn 的 CLI 子进程；即使这里显式传了
    // cwd: workDir，CLI 子进程里 preload.ts 还是会 chdir('/')，结果把
    // STATE.cwd / "Primary working directory" 打回根目录，IM 会话里 AI 感知的
    // 工作目录就变成 `/`。把 CALLER_DIR / PWD 显式覆盖成 workDir，preload.ts
    // chdir 后落到正确目录。
    //
    const networkSettings = await loadNetworkSettings()
    const networkRuntimeMetadata = { firstTokenTimeoutDerived: false }
    const childEnv = await this.buildChildEnv(
      launchWorkDir,
      sdkUrl,
      options,
      networkSettings,
      networkRuntimeMetadata,
      sessionId,
    )
    const usesOfficialOAuth = this.shouldMarkManagedOAuth(options?.providerId)

    let proc: ReturnType<typeof Bun.spawn>
    try {
      proc = Bun.spawn(args, buildConversationCliSpawnOptions(launchWorkDir, childEnv))
    } catch (spawnErr) {
      void diagnosticsService.recordEvent({
        type: 'cli_spawn_failed',
        severity: 'error',
        sessionId,
        summary: spawnErr instanceof Error ? spawnErr.message : String(spawnErr),
        details: {
          workDir,
          permissionMode: options?.permissionMode || 'default',
          providerId: options?.providerId ?? null,
          model: options?.model ?? null,
          error: spawnErr,
        },
      })
      throw new ConversationStartupError(
        `Failed to spawn CLI in ${launchWorkDir}: ${
          spawnErr instanceof Error ? spawnErr.message : String(spawnErr)
        }`,
        'CLI_SPAWN_FAILED',
      )
    }

    let resolveSdkAttached: (() => void) | null = null
    const sdkAttached = new Promise<void>((resolve) => {
      resolveSdkAttached = resolve
    })
    const session: SessionProcess = {
      proc,
      outputCallbacks: [],
      workDir: launchWorkDir,
      permissionMode: options?.permissionMode || 'default',
      networkRoutingFingerprint: networkRoutingFingerprint(networkSettings, childEnv),
      networkDerivedFirstTokenTimeout: networkRuntimeMetadata.firstTokenTimeoutDerived,
      sdkToken: this.getSdkTokenFromUrl(sdkUrl),
      sdkSocket: null,
      seenSdkMessageUuids: new Set<string>(),
      sdkAttached,
      resolveSdkAttached,
      pendingOutbound: [],
      startupPending: true,
      startupExitCode: null,
      stdoutLines: [],
      stderrLines: [],
      outputDrain: Promise.resolve(),
      sdkMessages: [],
      sdkMessageBytes: 0,
      initMessage: null,
      usesOfficialOAuth,
      officialOAuthToken: childEnv.CLAUDE_CODE_OAUTH_TOKEN ?? null,
      pendingPermissionRequests: new Map(),
      servantNonInteractive,
    }
    this.sessions.set(sessionId, session)
    // registry phase 接线（阶段2 · 5d）：登记（幂等，兼容 handler 阶段1先行
    // ensureSessionRegistered 的场景）→ starting；成功后 running。
    registerSession(sessionId)
    markStarting(sessionId)

    session.outputDrain = Promise.all([
      this.readProcessOutputStream(sessionId, proc.stdout, 'stdout'),
      this.readProcessOutputStream(sessionId, proc.stderr, 'stderr'),
    ]).then(() => undefined)

    proc.exited.then((code) => {
      void this.handleProcessExit(sessionId, proc, code)
    })

    const STARTUP_GRACE_MS = 3000
    let startupGraceTimer: ReturnType<typeof setTimeout> | undefined
    const earlyExitCode = await Promise.race([
      proc.exited,
      session.sdkAttached.then(() => null),
      new Promise<null>((resolve) =>
        startupGraceTimer = setTimeout(() => resolve(null), STARTUP_GRACE_MS),
      ),
    ])
    if (startupGraceTimer) clearTimeout(startupGraceTimer)

    const startupExitCode = earlyExitCode ?? session.startupExitCode
    if (startupExitCode !== null) {
      await this.waitForProcessOutputDrain(session)
      const startupError = this.buildStartupError(sessionId, startupExitCode)
      // registry 记账（阶段2 · 5d）：拉起失败 = crashed 中间态（保留元数据等
      // 显式决策；stale-lock 重试走 crashed→starting 合法迁移）。
      // 注意：session 对象保留在 sessions map（元数据），由 DELETE API 走 tombstone。
      markCrashed(sessionId, { startup: true, exitCode: startupExitCode })

      if (this.clearStaleLock(sessionId)) {
        console.log(
          `[ConversationService] Removed stale lock for ${sessionId}, retrying...`,
        )
        return this.startSessionInternal(sessionId, workDir, sdkUrl, options)
      }

      // console.error/warn 会被诊断采集镜像成 error/warn 事件，信息级回收
      // （预热空闲回收的 SIGTERM）必须走 console.log，避免污染 runtime-errors
      const startupSeverity = cliExitSeverity(startupExitCode)
      const logStartupExit = startupSeverity === 'error' ? console.error : console.log
      logStartupExit(
        `[ConversationService] CLI exited with code ${startupExitCode} for ${sessionId}: ${startupError.message}`,
      )
      void diagnosticsService.recordEvent({
        type: 'cli_start_failed',
        severity: startupSeverity,
        sessionId,
        summary: startupError.message,
        details: {
          code: startupError.code,
          exitCode: startupExitCode,
          retryable: startupError.retryable,
          workDir: launchWorkDir,
          permissionMode: options?.permissionMode || 'default',
          providerId: options?.providerId ?? null,
          model: options?.model ?? null,
          capturedOutput: this.buildCapturedProcessOutputDetail(session),
          sdkMessages: this.summarizeSdkMessages(session.sdkMessages),
        },
      })
      throw startupError
    }

    session.startupPending = false

    const shouldPersistRuntimeMetadata =
      options?.providerId !== undefined ||
      !!options?.model ||
      !!options?.effort
    if (shouldReplacePlaceholder || !launchInfo || shouldPersistRuntimeMetadata) {
      await sessionService.appendSessionMetadata(sessionId, {
        workDir: launchWorkDir,
        customTitle: launchInfo?.customTitle ?? null,
        repository: launchRepository,
        permissionMode: options?.permissionMode || launchInfo?.permissionMode,
        ...(options?.providerId !== undefined
          ? { runtimeProviderId: options.providerId }
          : {}),
        ...(options?.model ? { runtimeModelId: options.model } : {}),
        ...(options?.effort ? { effortLevel: options.effort } : {}),
      })
    }

    completeSdkStartupConfirmation(sessionId, session, { sessions: this.sessions }, options)
  }

  onOutput(sessionId: string, callback: (msg: any) => void): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.outputCallbacks.push(callback)
    }
  }

  clearOutputCallbacks(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.outputCallbacks = []
    }
  }

  removeOutputCallback(sessionId: string, callback: (msg: any) => void): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.outputCallbacks = session.outputCallbacks.filter((entry) => entry !== callback)
  }

  getRecentSdkMessages(sessionId: string): any[] {
    return [...(this.sessions.get(sessionId)?.sdkMessages ?? [])]
  }

  getSessionInitMessage(sessionId: string): any | null {
    return this.sessions.get(sessionId)?.initMessage ?? null
  }
  async sendMessage(
    sessionId: string,
    content: string,
    attachments?: AttachmentRef[],
  ): Promise<boolean> {
  const userContent = await this.buildUserContent(await appendRosterDigestIfSupervisor(sessionId, content), sessionId, attachments)
    let session = this.sessions.get(sessionId)
    if (session && !await this.refreshNetworkEnvironmentBeforeTurn(sessionId, session)) {
      return false
    }
    session = this.sessions.get(sessionId)
    if (session) {
      await this.refreshOfficialOAuthTokenBeforeTurn(sessionId, session)
    }
    return this.sendSdkMessage(sessionId, {
      type: 'user',
      message: {
        role: 'user',
        content: userContent,
      },
      parent_tool_use_id: null,
      session_id: '',
    })
  }

  private async refreshNetworkEnvironmentBeforeTurn(
    sessionId: string,
    session: SessionProcess,
  ): Promise<boolean> {
    const settings = await loadNetworkSettings()
    const baseEnv = await getProcessEnvWithTerminalShellEnvironment()
    const networkEnv = buildNetworkEnvironment(settings, baseEnv)
    const fingerprint = networkRoutingFingerprint(settings, {
      ...baseEnv,
      ...networkEnv,
    })

    if (this.sessions.get(sessionId) !== session) return false
    if (!session.networkRoutingFingerprint) {
      session.networkRoutingFingerprint = fingerprint
      return true
    }
    if (session.networkRoutingFingerprint === fingerprint) return true

    const noProxy = networkEnv.no_proxy || networkEnv.NO_PROXY || ''
    const variables: Record<string, string> = {
      ...networkEnv,
      NO_PROXY: noProxy,
      no_proxy: noProxy,
    }
    if (session.networkDerivedFirstTokenTimeout) {
      variables.CLAUDE_STREAM_FIRST_TOKEN_TIMEOUT_MS = networkEnv.API_TIMEOUT_MS
    }

    const sent = this.sendSdkMessage(sessionId, {
      type: 'update_environment_variables',
      variables,
    })
    if (sent && this.sessions.get(sessionId) === session) {
      session.networkRoutingFingerprint = fingerprint
    }
    return sent
  }

  respondToPermission(
    sessionId: string,
    requestId: string,
    allowed: boolean,
    rule?: string,
    updatedInput?: Record<string, unknown>,
    denyMessage?: string,
    permissionUpdates?: unknown[],
  ): boolean {
    const session = this.sessions.get(sessionId)
    const pendingRequest = session?.pendingPermissionRequests.get(requestId)
    if (!pendingRequest) {
      // P0-b（裁决十九③）：无 pending 即 no-op —— 对不存在的 pending 发 control_response
      // 在任何路径都不合法（客户端双击竞态今天就有），故收紧契约。debug 留痕便于复核。
      logForDiagnosticsNoPII('debug', 'permission_response_without_pending', { sessionId, requestId })
      return false
    }
    // P0-b（裁决十八②）：清理挂在既有删除路径上。
    clearPermissionTimeout(pendingRequest)
    if (session) {
      session.pendingPermissionRequests.delete(requestId)
      // registry 记账（阶段2 · 5c）：权限等待状态单一权威源同步
      setAwaitingPermission(sessionId, session.pendingPermissionRequests.size > 0)
    }

    return this.sendSdkMessage(sessionId, {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: allowed
          ? {
              behavior: 'allow',
              updatedInput: updatedInput ?? {},
              ...(Array.isArray(permissionUpdates) && permissionUpdates.length > 0
                ? { updatedPermissions: permissionUpdates }
                : rule === 'always' && pendingRequest
                ? {
                    updatedPermissions: [
                      ...normalizeSessionPermissionUpdates(
                        pendingRequest.permissionSuggestions,
                        pendingRequest.toolName,
                      ),
                    ],
                  }
                : {}),
            }
          : {
              behavior: 'deny',
              // No `interrupt`: the denial travels back to the model as a
              // tool_result so it can acknowledge the rejection and stop on its
              // own. Aborting the turn instead (#1051) kept the model from ever
              // seeing the denial, so a rejected tool ended the turn silently.
              // REJECT_MESSAGE carries the "STOP and wait for the user"
              // instruction that the abort used to enforce; 'User denied via UI'
              // was a debug string the model had no way to act on.
              // ExitPlanMode is the exception — rejecting it means "keep
              // planning", so the model is told to revise rather than stop.
              message: buildDenyMessage(pendingRequest?.toolName, denyMessage),
            },
      },
    })
  }

  async setPermissionMode(sessionId: string, mode: string, timeoutMs = 10_000): Promise<boolean> {
    if (!this.sessions.has(sessionId)) return false
    this.trackPendingPermissionModeChange(sessionId, mode, 1)

    let confirmationSettled = false
    let confirmationTimeout: ReturnType<typeof setTimeout> | undefined
    let handleOutput: ((msg: any) => void) | undefined
    let rejectConfirmation: ((reason?: unknown) => void) | undefined
    const cleanupConfirmation = () => {
      if (confirmationTimeout !== undefined) clearTimeout(confirmationTimeout)
      if (handleOutput) this.removeOutputCallback(sessionId, handleOutput)
    }
    const cancelConfirmation = (reason: unknown) => {
      if (confirmationSettled) return
      confirmationSettled = true
      cleanupConfirmation()
      rejectConfirmation?.(reason)
    }
    const confirmation = new Promise<void>((resolve, reject) => {
      rejectConfirmation = reject
      handleOutput = (msg: any) => {
        if (
          msg?.type !== 'system' ||
          msg.subtype !== 'status' ||
          msg.permissionMode !== mode
        ) {
          return
        }

        confirmationSettled = true
        cleanupConfirmation()
        resolve()
      }
      this.onOutput(sessionId, handleOutput)
    })
    // requestControl can reject before the confirmation promise is awaited.
    // Attach a handler immediately so a later confirmation timeout is never unhandled.
    void confirmation.catch(() => undefined)

    try {
      const startedAt = Date.now()
      await this.requestControl(sessionId, {
        subtype: 'set_permission_mode',
        mode,
      }, timeoutMs)
      if (!confirmationSettled) {
        const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt))
        confirmationTimeout = setTimeout(() => {
          cancelConfirmation(new Error(`Timed out waiting for permission mode confirmation: ${mode}`))
        }, remainingMs)
      }
      await confirmation

      return this.sessions.has(sessionId)
    } catch (err) {
      cancelConfirmation(err)
      throw err
    } finally {
      this.trackPendingPermissionModeChange(sessionId, mode, -1)
    }
  }

  recordSessionPermissionMode(sessionId: string, mode: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.permissionMode = mode
    return true
  }

  setMaxThinkingTokens(sessionId: string, maxThinkingTokens: number | null): boolean {
    return this.sendSdkMessage(sessionId, {
      type: 'control_request',
      request_id: crypto.randomUUID(),
      request: {
        subtype: 'set_max_thinking_tokens',
        max_thinking_tokens: maxThinkingTokens,
      },
    })
  }

  setMaxThinkingTokensForActiveSessions(maxThinkingTokens: number | null): number {
    let sent = 0
    for (const sessionId of this.getActiveSessions()) {
      if (this.setMaxThinkingTokens(sessionId, maxThinkingTokens)) {
        sent += 1
      }
    }
    return sent
  }

  sendInterrupt(sessionId: string): boolean {
    return this.sendSdkMessage(sessionId, {
      type: 'control_request',
      request_id: crypto.randomUUID(),
      request: { subtype: 'interrupt' },
    })
  }

  private isControlChannelReady(session: SessionProcess): boolean {
    return Boolean(session.sdkSocket)
  }

  private async waitForControlChannelReady(
    sessionId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const startedAt = Date.now()

    while (Date.now() - startedAt < timeoutMs) {
      if (signal?.aborted) throw controlRequestAbortReason(signal)
      const session = this.sessions.get(sessionId)
      if (!session) {
        throw new Error('CLI session is not running')
      }
      if (this.isControlChannelReady(session)) {
        return
      }
      await waitForControlPoll(CONTROL_READY_POLL_MS, signal)
    }

    throw new Error('Timed out waiting for CLI control channel to become ready')
  }

  async requestControl(
    sessionId: string,
    request: Record<string, unknown>,
    timeoutMs = 10_000,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (signal?.aborted) {
      return Promise.reject(controlRequestAbortReason(signal))
    }
    if (!this.sessions.has(sessionId)) {
      return Promise.reject(new Error('CLI session is not running'))
    }

    const startedAt = Date.now()
    await this.waitForControlChannelReady(sessionId, timeoutMs, signal)
    const responseTimeoutMs = Math.max(1, timeoutMs - (Date.now() - startedAt))
    const requestId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      let settled = false
      let timeout: ReturnType<typeof setTimeout>

      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        signal?.removeEventListener('abort', handleAbort)
        this.removeOutputCallback(sessionId, handleOutput)
        fn()
      }

      const handleAbort = () => {
        finish(() => reject(controlRequestAbortReason(signal!)))
      }

      const handleOutput = (msg: any) => {
        if (
          msg?.type !== 'control_response' ||
          msg.response?.request_id !== requestId
        ) {
          return
        }

        if (msg.response.subtype === 'error') {
          finish(() => reject(new Error(String(msg.response.error || 'Control request failed'))))
          return
        }

        finish(() => resolve(
          msg.response.response && typeof msg.response.response === 'object'
            ? msg.response.response as Record<string, unknown>
            : {},
        ))
      }

      timeout = setTimeout(() => {
        finish(() => reject(new Error(
          `Timed out waiting for ${String(request.subtype ?? 'control')} response`,
        )))
      }, responseTimeoutMs)
      this.onOutput(sessionId, handleOutput)
      signal?.addEventListener('abort', handleAbort, { once: true })
      if (signal?.aborted) {
        handleAbort()
        return
      }
      const sent = this.sendSdkMessage(sessionId, {
        type: 'control_request',
        request_id: requestId,
        request,
      })
      if (!sent) {
        finish(() => reject(new Error('CLI session is not running')))
      }
    })
  }

  /**
   * 会话是否有「活进程」语义（阶段2 · 5d）：crashed 会话进程已死，按不存在处理——
   * 消费方含 handler 的防重复拉起守卫（hasSession=true 会阻断重启，而
   * crashed→starting 重启是方案的合法路径）；元数据仍保留在 map（显式决策用），
   * 内部 getSession* 直读 map 的路径不受影响。
   */
  hasSession(sessionId: string): boolean {
    if (!this.sessions.has(sessionId)) return false
    return this.getActiveSessions().includes(sessionId)
  }

  getSessionWorkDir(sessionId: string): string {
    const session = this.sessions.get(sessionId)
    return session?.workDir || ''
  }

  updateSessionWorkDir(sessionId: string, workDir: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || !workDir.trim()) return
    session.workDir = workDir
  }

  getSessionPermissionMode(sessionId: string): string {
    const session = this.sessions.get(sessionId)
    return session?.permissionMode || 'default'
  }

  getPendingPermissionRequests(sessionId: string): PendingPermissionRequest[] {
    const session = this.sessions.get(sessionId)
    if (!session) return []

    return Array.from(session.pendingPermissionRequests.entries()).map(([requestId, request]) => ({
      requestId,
      toolName: request.toolName,
      ...(request.toolUseId ? { toolUseId: request.toolUseId } : {}),
      input: request.input,
      ...(request.description ? { description: request.description } : {}),
    }))
  }

  authorizeSdkConnection(
    sessionId: string,
    token: string | null | undefined,
  ): boolean {
    const session = this.sessions.get(sessionId)
    return Boolean(session && token && token === session.sdkToken)
  }

  attachSdkConnection(
    sessionId: string,
    socket: { send(data: string): void },
  ): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false

    session.sdkSocket = socket
    session.resolveSdkAttached?.()
    session.resolveSdkAttached = null
    while (session.pendingOutbound.length > 0) {
      const line = session.pendingOutbound.shift()
      if (line) {
        socket.send(line)
      }
    }
    return true
  }

  detachSdkConnection(
    sessionId: string,
    socket: { send(data: string): void },
  ): void {
    const session = this.sessions.get(sessionId)
    if (session?.sdkSocket === socket) {
      session.sdkSocket = null
      // 观察通道失联（v1.4.0 阶段2 · 6「转圈无上限」）：socket 断而进程未退
      // 时，该回合既等不到 result、也不会有进程退出事件——turn 无任何清除
      // 来源，前端转圈无上限。预防性清除（registry.dropActiveTurn）：CLI 重连
      // 后的 result 重放对已清回合是 no-op，新回合照常经注入/WS 路径重建。
      dropActiveTurn(sessionId, { cause: 'sdk_socket_disconnected' })
    }
  }

  /** SDK 控制通道当前是否连接（假死 watcher 判「盲区失联」用） */
  isSdkConnected(sessionId: string): boolean {
    return Boolean(this.sessions.get(sessionId)?.sdkSocket)
  }

  /**
   * CLI 的 WebSocketTransport 在每次重连成功后会把它的整个发送缓冲区重放一遍，
   * 并且明确假定「The server deduplicates by UUID」
   * （src/cli/transports/WebSocketTransport.ts:204）。这个契约以前没有实现：
   * 笔记本睡眠导致连接断开后（该 transport 有专门的睡眠检测，会无限重置重连预算），
   * CLI 重连时会把最多 1000 条**早已完成**的消息重新推上来，server 原样转发给前端，
   * 前端便把一整轮结束很久的对话当成实时输出重新渲染一遍 —— 表现为满屏「已思考」。
   *
   * 只有带 uuid 的消息才会进入 CLI 的重放缓冲（同文件 write()），所以这里也只按
   * uuid 判重；没有 uuid 的消息（如 control_request）本就不会被重放，照常处理。
   */
  private isReplayedSdkMessage(session: SessionProcess, msg: any): boolean {
    const uuid = typeof msg?.uuid === 'string' ? msg.uuid : ''
    if (!uuid) return false

    // 会话对象并非只有 startSession 一条构造路径，缺字段时按空集合起步而不是抛错。
    const seen = session.seenSdkMessageUuids ?? new Set<string>()
    session.seenSdkMessageUuids = seen
    if (seen.has(uuid)) return true

    if (seen.size >= MAX_SEEN_SDK_MESSAGE_UUIDS) {
      // Set 保持插入顺序，最早进来的就是最该淘汰的。
      const oldest = seen.values().next().value
      if (oldest !== undefined) seen.delete(oldest)
    }
    seen.add(uuid)
    return false
  }

  handleSdkPayload(sessionId: string, rawPayload: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    const lines = rawPayload
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)

    for (const line of lines) {
      try {
        const msg = JSON.parse(line)
        if (this.isReplayedSdkMessage(session, msg)) continue
        this.retainSdkMessage(session, msg, Buffer.byteLength(line, 'utf-8'))
        // 员工会话轮次结果观察：报错轮自动续跑（有界），成功轮重置连错。
        // 自动化实战验证过的"注入消息救活"，覆盖线上模型员工的 API 抖动中断。
        if (msg?.type === 'result') {
          this.observeServantTurnResult(sessionId, msg)
        }
        // 员工会话工具可用性观察：连续调用不存在的工具达阈值 → 中断该轮次并通知主管。
        this.observeServantToolResults(sessionId, msg)
        // 派活消费回执：按回合边界推进「投递成功 ≠ 已消费」的状态（纯内存查表，无副作用）。
        // is_error 随 result 传给 registry 的 observeTurnResult（meta 可回查）。
        observeSessionSdkMessage(sessionId, msg?.type, Date.now(), msg?.is_error === true)
        const sdkError = this.extractSdkErrorEvent(msg)
        if (sdkError) {
          void diagnosticsService.recordEvent({
            type: sdkError.type,
            severity: 'error',
            sessionId,
            summary: sdkError.summary,
            details: sdkError.details,
          })
        }
        if (msg?.type === 'system' && msg.subtype === 'init') {
          session.initMessage = msg
        }
        if (
          msg?.type == 'control_request' &&
          msg.request?.subtype === 'can_use_tool' &&
          typeof msg.request_id === 'string'
        ) {
          if (this.handleCanUseToolRequest(sessionId, session, msg)) continue
        }
        if (
          (msg?.type === 'control_cancel_request' || msg?.type === 'control_response') &&
          typeof msg.request_id === 'string'
        ) {
          session.pendingPermissionRequests.delete(msg.request_id)
          setAwaitingPermission(sessionId, session.pendingPermissionRequests.size > 0)
        }
        if (
          msg?.type === 'control_response' &&
          typeof msg.response?.request_id === 'string'
        ) {
          session.pendingPermissionRequests.delete(msg.response.request_id)
          setAwaitingPermission(sessionId, session.pendingPermissionRequests.size > 0)
        }
        this.notifyOutputCallbacks(sessionId, session.outputCallbacks, msg)
      } catch {
        console.warn(
          `[ConversationService] Ignoring malformed SDK payload for ${sessionId}`,
        )
      }
    }
  }

  private notifyOutputCallbacks(
    sessionId: string,
    callbacks: Array<(msg: any) => void>,
    message: any,
  ): void {
    for (const callback of [...callbacks]) {
      try {
        callback(message)
      } catch (error) {
        console.warn(
          `[ConversationService] Output callback failed for ${sessionId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }
  }

  private retainSdkMessage(
    session: SessionProcess,
    message: any,
    rawBytes: number,
  ): void {
    const retainedMessage = rawBytes <= MAX_CAPTURED_SDK_MESSAGE_BYTES
      ? message
      : this.compactSdkMessageForRetention(message, rawBytes)
    const retainedBytes = this.capturedSdkMessageBytes(retainedMessage)
    let totalBytes = session.sdkMessageBytes
      ?? session.sdkMessages.reduce(
        (total, existing) => total + this.capturedSdkMessageBytes(existing),
        0,
      )

    session.sdkMessages.push(retainedMessage)
    totalBytes += retainedBytes
    while (
      session.sdkMessages.length > MAX_CAPTURED_SDK_MESSAGES
      || totalBytes > MAX_CAPTURED_SDK_TOTAL_BYTES
    ) {
      const removed = session.sdkMessages.shift()
      if (removed === undefined) break
      totalBytes -= this.capturedSdkMessageBytes(removed)
    }
    session.sdkMessageBytes = Math.max(0, totalBytes)
  }

  private capturedSdkMessageBytes(message: any): number {
    return Buffer.byteLength(JSON.stringify(message), 'utf-8')
  }

  private compactSdkMessageForRetention(message: any, originalBytes: number): Record<string, unknown> {
    if (!message || typeof message !== 'object') {
      return { type: 'unknown', truncated: true, originalBytes }
    }

    const compact: Record<string, unknown> = {
      type: typeof message.type === 'string' ? message.type : 'unknown',
      truncated: true,
      originalBytes,
    }
    if (typeof message.subtype === 'string') compact.subtype = message.subtype
    if (typeof message.is_error === 'boolean') compact.is_error = message.is_error
    if (typeof message.isApiErrorMessage === 'boolean') {
      compact.isApiErrorMessage = message.isApiErrorMessage
    }
    for (const field of ['status', 'error', 'result'] as const) {
      const value = this.truncateSdkDiagnosticText(message[field])
      if (value !== undefined) compact[field] = value
    }
    if (Array.isArray(message.errors)) {
      compact.errors = message.errors
        .slice(0, 5)
        .map((value: unknown) => this.truncateSdkDiagnosticText(value))
        .filter((value: string | undefined): value is string => value !== undefined)
    }

    const assistantText = this.extractAssistantText(message)
    if (assistantText) {
      compact.message = {
        content: [{
          type: 'text',
          text: this.truncateSdkDiagnosticText(assistantText),
        }],
      }
    } else {
      const messageText = this.truncateSdkDiagnosticText(message.message)
      if (messageText !== undefined) compact.message = messageText
    }
    return compact
  }

  private truncateSdkDiagnosticText(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    if (Buffer.byteLength(value, 'utf-8') <= MAX_CAPTURED_SDK_DIAGNOSTIC_TEXT_BYTES) {
      return value
    }
    const prefixBytes = Buffer.from(
      value.slice(0, MAX_CAPTURED_SDK_DIAGNOSTIC_TEXT_BYTES),
      'utf-8',
    )
    const truncated = prefixBytes
      .subarray(0, MAX_CAPTURED_SDK_DIAGNOSTIC_TEXT_BYTES)
      .toString('utf-8')
      .replace(/\uFFFD$/, '')
    return `${truncated}\n[truncated]`
  }

  /**
   * 客户端**中途接入**（P0-b 裁决十九）：把该会话未决权限请求的超时**只延长**到
   * 「有客户端」档（15min）；不做缩短。由 handler 在 addActiveClient 唯一写入点调用。
   */
  onClientAttached(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    extendPermissionTimeoutsForClient(
      sessionId,
      session.pendingPermissionRequests,
      this.permissionTimeoutDeps(sessionId),
    )
  }

  /** P0-b：can_use_tool 收口——实现见 conversation/permissionTimeout.ts。 */
  private handleCanUseToolRequest(sessionId: string, session: SessionProcess, msg: any): boolean {
    return handleCanUseToolRequest({
      sessionId,
      requestId: msg.request_id,
      request: (msg.request ?? {}) as Record<string, unknown>,
      servantAutoDeny: session.servantNonInteractive && isServantNonInteractiveEnabled(),
      records: session.pendingPermissionRequests,
      deps: {
        ...this.permissionTimeoutDeps(sessionId),
        denyServant: (rid) => this.respondToPermission(sessionId, rid, false, undefined, undefined, COLLAB_SERVANT_PERMISSION_DENIED_MESSAGE),
      },
    })
  }
  /** P0-b：权限超时的门面侧依赖（登记与「客户端接入延长」共用）。 */
  private permissionTimeoutDeps(sessionId: string): PermissionTimeoutDeps {
    return {
      clientAttached: () => isSessionClientAttached(sessionId),
      hasSession: () => this.sessions.has(sessionId),
      deny: (rid) =>
        this.respondToPermission(sessionId, rid, false, undefined, undefined, PERMISSION_TIMEOUT_DENY_MESSAGE),
    }
  }

  stopSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    // registry 记账（阶段2 · 5d）：主动停止 = markStopped + clearSession
    // （进程对象删除是 stopped 的充分事实；条目随后移除）。
    markStopped(sessionId)
    clearSession(sessionId)
    // map 条目同步移除（阶段4 全量质检修复）：stopped 条目残留 map 会让
    // startSession 的防重复拉起守卫（hasSession）在 clearSession 删掉 registry
    // 条目后因 phase-undefined 保守保留而恒 true → 重启静默失效
    clearAllPermissionTimeouts(session.pendingPermissionRequests)
    this.sessions.delete(sessionId)
    this.killProcess(sessionId, session)
  }

  async stopSessionAndWait(
    sessionId: string,
    timeoutMs = DESKTOP_CLI_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
  ): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    markStopped(sessionId)
    clearSession(sessionId)
    clearAllPermissionTimeouts(session.pendingPermissionRequests)
    this.sessions.delete(sessionId)
    await this.stopProcessAndWait(sessionId, session, timeoutMs)
  }

  stopAllSessions(): void {
    for (const sessionId of this.getActiveSessions()) {
      this.stopSession(sessionId)
    }
  }

  async stopAllSessionsAndWait(
    timeoutMs = DESKTOP_CLI_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
  ): Promise<void> {
    const activeSessions = Array.from(this.sessions.entries())
    if (activeSessions.length === 0) return

    // registry 记账（阶段2 · 5d）：批量停止逐会话 markStopped + clearSession；
    // 进程对象仍全部清除（原 sessions.clear() 语义保真）
    for (const [sessionId] of activeSessions) {
      markStopped(sessionId)
      clearSession(sessionId)
    }
    this.sessions.clear()
    await Promise.all(
      activeSessions.map(([sessionId, session]) =>
        this.stopProcessAndWait(sessionId, session, timeoutMs),
      ),
    )
  }

  private async stopProcessAndWait(
    sessionId: string,
    session: SessionProcess,
    timeoutMs: number,
  ): Promise<void> {
    this.killProcess(sessionId, session, 'SIGTERM')

    const exited = await Promise.race([
      session.proc.exited.then(() => true, () => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ])
    if (!exited) {
      this.killProcess(sessionId, session, 'SIGKILL')
      await Promise.race([
        session.proc.exited.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ])
    }
    await this.waitForProcessOutputDrain(session, timeoutMs)
  }

  private killProcess(
    sessionId: string,
    session: SessionProcess,
    signal?: NodeJS.Signals,
  ): void {
    try {
      session.proc.kill(signal)
    } catch (error) {
      console.warn(
        `[ConversationService] Failed to kill CLI subprocess for ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  /**
   * 软删除（阶段3：迁移至 registry tombstone）。
   * 顺序关键：先 tombstoneSession（running→deleted 合法迁移，条目保留等恢复），
   * 再清进程对象——不走 stopSession（其 markStopped 对 deleted 态是非法迁移 no-op，
   * 且 clearSession 会把 tombstone 条目从 registry 删除，破坏「删除留痕/防复活」语义）。
   */
  markSessionDeleted(sessionId: string): void {
    tombstoneSession(sessionId)
    const session = this.sessions.get(sessionId)
    if (session) {
      clearAllPermissionTimeouts(session.pendingPermissionRequests)
      this.sessions.delete(sessionId)
      this.killProcess(sessionId, session)
    }
  }

  markSessionsDeleted(sessionIds: string[]): void {
    for (const sessionId of sessionIds) {
      this.markSessionDeleted(sessionId)
    }
  }

  /** 恢复软删除（阶段3：registerSession 对 tombstone 条目 = deleted→registered 合法恢复迁移） */
  unmarkSessionDeleted(sessionId: string): void {
    registerSession(sessionId)
  }

  unmarkSessionsDeleted(sessionIds: string[]): void {
    for (const sessionId of sessionIds) {
      this.unmarkSessionDeleted(sessionId)
    }
  }

  getActiveSessions(): string[] {
    // 阶段2（5d）：crashed/stopped/deleted 会话无活进程，不再视为 active
    // （stopAllSessions 遍历 kill、index.ts active 列表都只应看到有进程语义的会话）；
    // 未登记条目保守保留（旧行为）。
    return Array.from(this.sessions.keys()).filter((sessionId) => {
      const phase = getSessionSnapshot(sessionId)?.phase
      return phase === undefined || phase === 'starting' || phase === 'running'
    })
  }

  private async readProcessOutputStream(
    sessionId: string,
    stream: ReadableStream | null | undefined,
    streamName: 'stdout' | 'stderr',
  ): Promise<void> {
    if (!stream) return

    const reader = stream.getReader()
    const decoder = new TextDecoder()

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const text = decoder.decode(value, { stream: true })
        if (!text.trim()) continue

        const session = this.sessions.get(sessionId)
        if (session) {
          for (const line of text
            .split('\n')
            .map((entry) => entry.trim())
            .filter(Boolean)) {
            const lines =
              streamName === 'stderr' ? session.stderrLines : session.stdoutLines
            lines.push(this.redactProcessOutput(line))
            if (lines.length > MAX_CAPTURED_PROCESS_LINES) {
              lines.splice(0, lines.length - MAX_CAPTURED_PROCESS_LINES)
            }
          }
        }

        const logLine = this.redactProcessOutput(text.trim())
        if (streamName === 'stderr') {
          console.error(`[CLI:${sessionId}:stderr] ${logLine}`)
        } else {
          console.log(`[CLI:${sessionId}:stdout] ${logLine}`)
        }
      }
    } catch (error) {
      // Process output read failures should not kill the session — but they
      // must NOT be silent either: a dead reader pipe looks exactly like
      // "child produced no output" and forges the empty-capture signature
      // (cli_runtime_exit with no stderr/stdout). Leave a marker line so
      // exit-time diagnostics can tell the two apart.
      const marker = `[stream-read-error] failed reading CLI ${streamName}: ${
        error instanceof Error ? error.message : String(error)
      }`
      const session = this.sessions.get(sessionId)
      if (session) {
        const lines = streamName === 'stderr' ? session.stderrLines : session.stdoutLines
        lines.push(marker)
        if (lines.length > MAX_CAPTURED_PROCESS_LINES) {
          lines.splice(0, lines.length - MAX_CAPTURED_PROCESS_LINES)
        }
      }
      console.error(`[ConversationService] ${marker}`)
    }
  }

  private async waitForProcessOutputDrain(
    session: SessionProcess,
    timeoutMs = 250,
  ): Promise<{ drained: boolean }> {
    const outputDrain = session.outputDrain ?? Promise.resolve()
    const outcome = await Promise.race([
      outputDrain.then(() => 'drained' as const).catch(() => 'drained' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
    ])
    return { drained: outcome === 'drained' }
  }

  private sendSdkMessage(
    sessionId: string,
    payload: Record<string, unknown>,
  ): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false

    const line = JSON.stringify(payload) + '\n'
    const socket = session.sdkSocket
    if (socket) {
      try {
        socket.send(line)
      } catch (error) {
        // C4（v1.5.0）：写入同步异常 = socket 已死（半开/已关闭但 close 事件
        // 未到达）——主动 detach（内部会 dropActiveTurn 清 turn，避免转圈悬空），
        // 并按未送达返回，交给上层走失败路径（回执撤回/信箱降级）。
        logForDiagnosticsNoPII('warn', 'sdk_socket_send_failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        })
        this.detachSdkConnection(sessionId, socket)
        return false
      }
    } else {
      session.pendingOutbound.push(line)
    }
    return true
  }

  private async handleProcessExit(
    sessionId: string,
    proc: SessionProcess['proc'],
    code: number,
  ): Promise<void> {
    console.log(
      `[ConversationService] CLI process for ${sessionId} exited with code ${code}`,
    )

    const activeSession = this.sessions.get(sessionId)
    if (activeSession?.proc === proc) {
      if (activeSession.startupPending) {
        activeSession.startupExitCode = code
        return
      }
      const { drained } = await this.waitForProcessOutputDrain(activeSession)
      const exitError = this.buildRuntimeExitMessage(sessionId, code)
      void diagnosticsService.recordEvent({
        type: 'cli_runtime_exit',
        severity: cliExitSeverity(code),
        sessionId,
        summary: exitError,
        details: {
          exitCode: code,
          workDir: activeSession.workDir,
          permissionMode: activeSession.permissionMode,
          // 空 capturedOutput 时用于区分「管道没接住/读流故障」与「子进程
          // 静默退出（零输出即死，运行时级崩溃特征）」
          output_drained: drained,
          stderr_line_count: (activeSession.stderrLines ?? []).length,
          stdout_line_count: (activeSession.stdoutLines ?? []).length,
          capturedOutput: this.buildCapturedProcessOutputDetail(activeSession),
          sdkMessages: this.summarizeSdkMessages(activeSession.sdkMessages),
        },
      })
      // 员工会话异常崩溃通知（v1.3.0 阶段2 · 5e）：不再在此动态 import——
      // servantIncidentNotifier 顶层订阅 phase_changed(→crashed)，由上方
      // markCrashed 发出的事件触发（判定逻辑与事件顺序见该模块注释）。
      const callbacks = [...activeSession.outputCallbacks]
      this.notifyOutputCallbacks(sessionId, callbacks, {
        type: 'result',
        subtype: 'error',
        is_error: true,
        result: exitError,
        usage: { input_tokens: 0, output_tokens: 0 },
        session_id: sessionId,
      })
      // registry 记账（阶段2 · 5d）：markCrashed 时点在 drain 完成与合成 error
      // result 发出**之后**（09-26 质检修订）——保证观察者的事件顺序是
      // 「先 result 后 crashed」，不会倒挂。session 对象保留在 map（元数据：
      // pendingOutbound/权限请求等留待显式决策），getActiveSessions 已排除
      // crashed；删除走既有 DELETE API（tombstone），重启复用 startSession
      // （crashed→starting 合法迁移）。
      markCrashed(sessionId, { exitCode: code })
    }
  }

  // ── v1.7 结构拆分第②批：下面两个搬到 conversation/cliArgs.ts，同名类字段委托。
  // 同批的 resolveCliArgs / buildSessionCliArgs 因 import.meta.dir 依赖未搬（见那里）。
  private getPermissionArgs = getPermissionArgs

  private getRuntimeArgs = getRuntimeArgs

  /**
   * 协作身份缓存：sessionId → 主管标记与约束档位（负缓存也存，
   * 避免每次启动都读花名册文件）。任命/卸任/改档位时失效。
   */
  private supervisorSessionCache = new Map<
    string,
    {
      supervisor: boolean
      registered: boolean
      /** v1.6.1：在册且非主管——员工会话的免审批兜底只作用于这一类 */
      servant: boolean
      constraint?: 'readonly' | 'whitelist'
      writeDirs?: string[]
    }
  >()

  /** 协作身份变化后调用（任命/卸任/移除），让下次会话启动按最新花名册注入标记 */
  invalidateSupervisorCache(sessionId?: string): void {
    if (sessionId === undefined) this.supervisorSessionCache.clear()
    else this.supervisorSessionCache.delete(sessionId)
  }

  /** 员工会话连错轮数：报错 +1，成功清零；达到阈值升级主管并停止自动续跑 */
  private servantTurnErrorStreak = new Map<string, number>()

  /**
   * 员工会话轮次结果观察（同步钩子，副作用走异步通知）：
   * 报错轮 → servantIncidentNotifier 决定自动续跑/升级主管；
   * 成功轮 → 清零。非员工会话由 notifier 侧自行清理，不影响任何行为。
   */
  private observeServantTurnResult(sessionId: string, msg: { type?: string; is_error?: boolean; result?: unknown }): void {
    if (msg.type !== 'result') return
    if (msg.is_error === true) {
      const streak = (this.servantTurnErrorStreak.get(sessionId) ?? 0) + 1
      this.servantTurnErrorStreak.set(sessionId, streak)
      const summary = typeof msg.result === 'string' ? msg.result.slice(0, 300) : ''
      void import('./servantIncidentNotifier.js')
        .then(({ onServantTurnError }) => onServantTurnError({ sessionId, streak, summary }))
        .catch((error) => {
          // C5（v1.5.0）：通知路径的吞错至少留诊断（此前 .catch(() => {}) 静默，
          // 通知失效在日志里无迹可查）
          logForDiagnosticsNoPII('warn', 'servant_incident_notify_failed', {
            sessionId,
            hook: 'onServantTurnError',
            error: error instanceof Error ? error.message : String(error),
          })
        })
      return
    }
    if (this.servantTurnErrorStreak.has(sessionId)) {
      this.servantTurnErrorStreak.delete(sessionId)
      void import('./servantIncidentNotifier.js')
        .then(({ clearServantTurnErrors }) => clearServantTurnErrors(sessionId))
        .catch((error) => {
          logForDiagnosticsNoPII('warn', 'servant_incident_notify_failed', {
            sessionId,
            hook: 'clearServantTurnErrors',
            error: error instanceof Error ? error.message : String(error),
          })
        })
    }
    // 轮次成功也清零「连续调用不存在工具」计数（语义见 servantIncidentNotifier）。
    void import('./servantIncidentNotifier.js')
      .then(({ resetUnknownToolStreak }) => resetUnknownToolStreak(sessionId))
      .catch((error) => {
        logForDiagnosticsNoPII('warn', 'servant_incident_notify_failed', {
          sessionId,
          hook: 'resetUnknownToolStreak',
          error: error instanceof Error ? error.message : String(error),
        })
      })
  }

  /**
   * 员工会话工具调用观察：把每条消息里的 tool_result 文本交给熔断器判定。
   *
   * 只读消息自带的字段，不做额外映射：不存在工具的 tool_result 文本里已带
   * 「No such tool available: <toolName>」，通知所需信息足够；其余任何 tool_result
   * 都表示"这个工具确实存在"，用于清零连续计数。
   */
  private observeServantToolResults(sessionId: string, msg: any): void {
    const content = msg?.message?.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (!block || typeof block !== 'object' || block.type !== 'tool_result') continue
      const resultText = this.toolResultText(block)
      const isError = (block as { is_error?: unknown }).is_error === true
      void import('./servantIncidentNotifier.js')
        .then(({ onServantToolResult }) => onServantToolResult({ sessionId, resultText, isError }))
        .catch((error) => {
          logForDiagnosticsNoPII('warn', 'servant_incident_notify_failed', {
            sessionId,
            hook: 'onServantToolResult',
            error: error instanceof Error ? error.message : String(error),
          })
        })
    }
  }

  /** tool_result 的 content 可能是字符串，也可能是 content block 数组 */
  private toolResultText(block: { content?: unknown }): string {
    const content = block.content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content
      .map((part) =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join('\n')
  }

  private async isRegisteredSupervisor(sessionId: string): Promise<{
    supervisor: boolean
    /** 是否花名册在册的协作会话（主管或员工都算；A7 据此不注入 computer-use） */
    registered: boolean
    /** v1.6.1：在册且非主管 */
    servant: boolean
    constraint?: 'readonly' | 'whitelist'
    writeDirs?: string[]
  }> {
    const cached = this.supervisorSessionCache.get(sessionId)
    if (cached !== undefined) return cached
    let info: {
      supervisor: boolean
      registered: boolean
      servant: boolean
      constraint?: 'readonly' | 'whitelist'
      writeDirs?: string[]
    } = { supervisor: false, registered: false, servant: false }
    try {
      // v1.3.0 阶段4 · 7a：花名册查询走依赖注入（servantInfoSource），
      // 未注入时 getServantEntry 返回 null = 按非主管处理（原 catch 降级语义）
      const entry = await getServantEntry(sessionId)
      const supervisor = Boolean(entry?.supervisor)
      info = {
        supervisor,
        registered: entry !== null,
        // 契约 §3.1：服务端侧用花名册的 enabled && !supervisor 判定员工
        servant: entry !== null && !supervisor && entry.enabled !== false,
        ...(entry?.constraint === 'readonly' || entry?.constraint === 'whitelist'
          ? { constraint: entry.constraint }
          : {}),
        ...(entry?.constraint === 'whitelist' && entry.writeDirs?.length
          ? { writeDirs: entry.writeDirs }
          : {}),
      }
    } catch {
      // 花名册读取失败按非主管处理：收权是加强项，不能阻塞会话启动
    }
    this.supervisorSessionCache.set(sessionId, info)
    return info
  }

  private async getCollabIdentity(sessionId: string): Promise<{
    supervisor: boolean
    registered: boolean
    servant: boolean
    constraint?: 'readonly' | 'whitelist'
    writeDirs?: string[]
  }> {
    return this.isRegisteredSupervisor(sessionId)
  }

  /**
   * v1.6.1（契约 §3.3 第 2 条）：会话是不是员工（花名册在册且非主管）。
   * 供 handler 拒绝员工把权限模式切出 bypass 使用。
   */
  async isServantSession(sessionId: string): Promise<boolean> {
    return (await this.getCollabIdentity(sessionId)).servant
  }

  private async buildChildEnv(
    workDir: string,
    sdkUrl?: string,
    options?: SessionStartOptions,
    networkSettingsOverride?: NetworkSettings,
    networkRuntimeMetadata?: { firstTokenTimeoutDerived: boolean },
    sessionId?: string,
  ): Promise<Record<string, string>> {
    // 协作身份（主管标记/约束档位/白名单目录）取一次复用（带缓存）
    const collabIdentity = sessionId ? await this.getCollabIdentity(sessionId) : null
    // Provider isolation: when Desktop has its own provider config/index,
    // strip inherited provider env vars so the child CLI reads fresh values
    // from ~/.claude/cc-heihei/settings.json instead of stale process.env.
    //
    // If the user never configured a Desktop provider and only launched the
    // app/server with ANTHROPIC_* env vars, keep those env vars so Windows
    // dev-mode and env-only setups can still authenticate successfully.
    const PROVIDER_ENV_KEYS = [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_AUTH_TOKEN',
      'ENABLE_TOOL_SEARCH',
      'ANTHROPIC_MODEL',
      'ANTHROPIC_DEFAULT_FABLE_MODEL',
      'ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION',
      'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME',
      'ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
      'CC_HEIHEI_SEND_DISABLED_THINKING',
      'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
      'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
      'CLAUDE_CODE_ATTRIBUTION_HEADER',
      'CLAUDE_CODE_MODEL_CONTEXT_WINDOWS',
      OPENAI_OAUTH_PROVIDER_ENV_KEY,
      OPENAI_CODEX_OAUTH_FILE_ENV_KEY,
      OPENAI_CODEX_REASONING_EFFORT_ENV_KEY,
      GROK_OAUTH_PROVIDER_ENV_KEY,
      GROK_OAUTH_FILE_ENV_KEY,
    ] as const

    const cleanEnv = await getProcessEnvWithTerminalShellEnvironment()
    if (networkRuntimeMetadata) {
      networkRuntimeMetadata.firstTokenTimeoutDerived =
        !cleanEnv.CLAUDE_STREAM_FIRST_TOKEN_TIMEOUT_MS
    }
    delete cleanEnv.CLAUDE_CODE_OAUTH_TOKEN
    if (options?.resumeInterruptedTurn === false) {
      delete cleanEnv.CLAUDE_CODE_RESUME_INTERRUPTED_TURN
    }
    delete cleanEnv.CC_HEIHEI_TRACE_PROVIDER_ID
    delete cleanEnv.CC_HEIHEI_TRACE_PROVIDER_NAME
    delete cleanEnv.CC_HEIHEI_TRACE_PROVIDER_FORMAT
    if (this.shouldStripInheritedProviderEnv(options?.providerId)) {
      for (const key of PROVIDER_ENV_KEYS) {
        delete cleanEnv[key]
      }
    }

    let desktopServerUrl: string | undefined
    if (sdkUrl) {
      try {
        const parsed = new URL(sdkUrl)
        desktopServerUrl = `http://${parsed.host}`
      } catch {
        desktopServerUrl = undefined
      }
    }

    const explicitProvider =
      typeof options?.providerId === 'string'
        ? await this.providerService.getProvider(options.providerId)
        : null
    const explicitProviderEnv = explicitProvider
      ? await this.providerService.getProviderRuntimeEnv(explicitProvider.id)
      : null
    const networkEnv = buildNetworkEnvironment(
      networkSettingsOverride ?? await loadNetworkSettings(),
      cleanEnv,
    )
    const traceCaptureEnabled = (await readTraceCaptureSettings()).enabled
    if (explicitProviderEnv && options?.model?.trim()) {
      explicitProviderEnv.ANTHROPIC_MODEL = options.model.trim()
    }
    const attributionHeaderEnv = attributionHeaderEnvForModel(
      options?.model?.trim() ||
        explicitProviderEnv?.ANTHROPIC_MODEL ||
        cleanEnv.ANTHROPIC_MODEL,
    )

    let cliDiagnosticsPath: string | undefined
    try {
      await diagnosticsService.prepareCliDiagnosticsStorage()
      cliDiagnosticsPath = diagnosticsService.getCliDiagnosticsPath()
    } catch {
      // Diagnostics must never block session startup or point the child at an
      // unsafe path when private storage could not be prepared.
    }

    return {
      ...cleanEnv,
      CLAUDE_CODE_ENABLE_TASKS: '1',
      CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1',
      // Desktop must fail stuck provider streams instead of leaving the UI running forever.
      CLAUDE_ENABLE_STREAM_WATCHDOG: cleanEnv.CLAUDE_ENABLE_STREAM_WATCHDOG || '1',
      // Third-party providers can stay silent for minutes mid-stream (thinking
      // phases emit no SSE bytes, and many gateways never send pings), so the
      // CLI's 90s idle default kills healthy streams (#766). 240s still frees
      // a truly dead connection without shooting slow ones.
      CLAUDE_STREAM_IDLE_TIMEOUT_MS: cleanEnv.CLAUDE_STREAM_IDLE_TIMEOUT_MS || '240000',
      // Overall wall-clock cap for one streaming response, NOT reset by chunks.
      // The 240s idle timer above is reset by every SSE event, so an upstream
      // that trickles content deltas (e.g. a huge tool_use input_json_delta)
      // just under 240s apart keeps it alive forever and the request hangs with
      // no completion (#766: "卡住" with slowly growing tokens). This independent
      // cap frees such a stream after a fixed duration regardless of trickle.
      // 本地模型（baseUrl 指向本机 llama-server）生成慢但健康，10 分钟硬上限
      // 会掐断大改动的长生成（员工任务中断、改到一半需要人工收拾）——放宽到
      // 30 分钟；真·卡死仍由 240s idle 看门狗兜住。云端保持 600s（#766 防挂死）。
      CLAUDE_STREAM_MAX_DURATION_MS:
        cleanEnv.CLAUDE_STREAM_MAX_DURATION_MS ||
        (explicitProvider && /localhost|127\.0\.0\.1|::1|\[::1\]|0\.0\.0\.0/i.test(explicitProvider.baseUrl ?? '')
          ? '1800000'
          : '600000'),
      // Time-to-first-token budget: how long to wait for the FIRST streamed
      // chunk after response headers arrive. The idle timer above is the wrong
      // knob for slow prefill — it kills healthy local/3P models that take
      // minutes to emit their first token (#826). Tie this to the user's
      // request-timeout setting (API_TIMEOUT_MS, from networkEnv) so raising
      // "请求超时" actually extends how long we wait for the first token. The
      // CLI switches to the shorter idle budget once tokens start flowing.
      CLAUDE_STREAM_FIRST_TOKEN_TIMEOUT_MS:
        cleanEnv.CLAUDE_STREAM_FIRST_TOKEN_TIMEOUT_MS || networkEnv.API_TIMEOUT_MS,
      // When a stream does get aborted, retry as streaming instead of falling
      // back to non-streaming: a non-streaming request must wait for the FULL
      // generation before the first response byte, so slow providers can never
      // finish inside API_TIMEOUT_MS — the fallback loops 5-minute aborts
      // forever while the UI shows "running" (#766). It can also double-run
      // tools (upstream inc-4258).
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: cleanEnv.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK || '1',
      ...(cliDiagnosticsPath ? { CLAUDE_CODE_DIAGNOSTICS_FILE: cliDiagnosticsPath } : {}),
      CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: this.resolveDesktopAutoMemoryPath(workDir),
      CALLER_DIR: workDir,
      PWD: workDir,
      // v1.6.0：会话工作目录的**显式**来源。主管收权守卫（supervisorGuard）
      // 此前用 process.cwd() 判断「是否在工作目录之外」——而进程 cwd 受
      // preload chdir、CLI 内部切换、resume 复用等多处影响，实测出现过
      // 「会话显示 workDir=A，但 Write 到 A 的兄弟目录被判成 A 之内而拒绝」
      // （2026-09-30 主管报告）。守卫改为优先读本变量，与用户看到的 workDir
      // 严格一致；变量缺失时才回退 process.cwd()（老版本服务端兼容）。
      CC_HEIHEI_WORK_DIR: workDir,
      ...(sdkUrl
        ? {
            // Runtime config changes restart the SDK child as soon as its result
            // arrives. Flush the completed turn first so the replacement can
            // reliably choose --resume and load the context (#1033).
            CLAUDE_CODE_EAGER_FLUSH: cleanEnv.CLAUDE_CODE_EAGER_FLUSH || '1',
            CC_HEIHEI_COMPUTER_USE_HOST_BUNDLE_ID: 'com.claude-code-heihei.desktop',
          }
        : {}),
      ...(sdkUrl && traceCaptureEnabled
        ? { CC_HEIHEI_TRACE_API_CALLS: '1' }
        : {}),
      ...(sdkUrl && traceCaptureEnabled && explicitProvider
        ? {
            CC_HEIHEI_TRACE_PROVIDER_ID: explicitProvider.id,
            CC_HEIHEI_TRACE_PROVIDER_NAME: explicitProvider.name,
            CC_HEIHEI_TRACE_PROVIDER_FORMAT: explicitProvider.apiFormat ?? 'anthropic',
          }
        : {}),
      ...(desktopServerUrl
        ? { CC_HEIHEI_DESKTOP_SERVER_URL: desktopServerUrl }
        : {}),
      // 会话级上下级协作：让会话内的 Bash 能可靠拿到自己的服务端会话 ID
      // （CLAUDE_CODE_SESSION_ID 是 CLI 内部 id，且可能为空，不能用于回邮地址）
      ...(sessionId ? { CC_HEIHEI_SESSION_ID: sessionId } : {}),
      // 主管会话标记 + 员工约束档位：CLI 侧据此做结构性收权（主管只派活不干活、
      // readonly 员工禁改文件、whitelist 员工仅白名单目录内可写；提示词约束会被
      // 延续对话的旧上下文压过，机制兜底见 collaboration/supervisorGuard）
      ...(collabIdentity?.supervisor ? { CC_HEIHEI_SUPERVISOR: '1' } : {}),
      // v1.6.0 CLI 契约 §三：显式的协作身份标记。此前员工身份只能从「没有主管
      // 标记」去猜，不可靠。主管 → supervisor、在册员工 → servant；非协作会话与
      // 用户会话（collabIdentity 为 null 或未在册）**不注入**，普通会话零变化。
      ...(collabIdentity?.supervisor
        ? { CC_HEIHEI_COLLAB_ROLE: 'supervisor' }
        : collabIdentity?.registered
          ? { CC_HEIHEI_COLLAB_ROLE: 'servant' }
          : {}),
      // A7（v1.5.0）：协作会话（主管/员工，即花名册在册）不注入 computer-use
      // 系列工具——无人值守场景无人审批桌面权限，工具在场只会诱导模型浪费
      // 轮次。走上游自带开关（utils/computerUse/gates.ts getChicagoEnabled）；
      // 普通（非协作）会话不注入，行为不变。
      ...(collabIdentity?.registered ? { CLAUDE_COMPUTER_USE_ENABLED: '0' } : {}),
      // v1.6.1（契约 §3.6）：员工会话免审批兜底开关，默认开。CLI 侧据此裁剪
      // 交互类工具，服务端据此自动拒绝漏网的 can_use_tool。只对员工注入（主管
      // 的 AskUserQuestion 是唯一升级出口，必须可用），置 '0' 即关闭。
      ...(collabIdentity?.servant
        ? {
            [COLLAB_SERVANT_NONINTERACTIVE_ENV]: isServantNonInteractiveEnabled() ? '1' : '0',
          }
        : {}),
      ...(collabIdentity?.constraint === 'readonly'
        ? { CC_HEIHEI_SERVANT_CONSTRAINT: 'readonly' }
        : {}),
      ...(collabIdentity?.constraint === 'whitelist'
        ? {
            CC_HEIHEI_SERVANT_CONSTRAINT: 'whitelist',
            // 缺列表注入空串：guard 侧解析为空 → 全拒（最严格解释）
            CC_HEIHEI_SERVANT_WRITE_DIRS: (collabIdentity.writeDirs ?? []).join('\n'),
          }
        : {}),
      ...(sdkUrl
        ? {
            CC_HEIHEI_DESKTOP_AWAIT_MCP: '1',
            CC_HEIHEI_DESKTOP_AWAIT_MCP_TIMEOUT_MS: '5000',
          }
        : {}),
      // Tell the CLI entrypoint to skip project .env loading. Provider env
      // should come from Desktop-managed config or inherited launch env, not
      // be reintroduced from the repo's .env file.
      CC_HEIHEI_SKIP_DOTENV: '1',
      // Keep the SDK runtime identity for auth and client behavior, but stamp
      // desktop-owned transcripts with an entrypoint visible to Claude /resume.
      CC_HEIHEI_TRANSCRIPT_ENTRYPOINT: 'claude-desktop',
      ...(explicitProviderEnv
        ? { CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1' }
        : {}),
      // "官方" 模式 (cc-heihei/settings.json 没 provider env) 下,把 CLI 标记为
      // managed-OAuth,让它忽略外部 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN
      // 残留、只走用户 /login 的 OAuth token。自定义 provider 模式绝不能设,
      // 否则 CLI 会忽略 provider 的 AUTH_TOKEN、错误地走 OAuth 打到第三方
      // endpoint。详见 src/utils/auth.ts isManagedOAuthContext()。
      ...(explicitProviderEnv ?? {}),
      ...(
        isOpenAIOfficialProviderId(options?.providerId) &&
        isOpenAIReasoningEffort(options?.effort)
          ? { [OPENAI_CODEX_REASONING_EFFORT_ENV_KEY]: options.effort }
          : {}
      ),
      ...networkEnv,
      ...(this.shouldMarkManagedOAuth(options?.providerId)
        ? await this.buildOfficialOAuthEnv()
        : {}),
      ...attributionHeaderEnv,
    }
  }

  private resolveDesktopAutoMemoryPath(workDir: string): string {
    const memoryProjectRoot = fs.existsSync(workDir)
      ? findCanonicalGitRoot(workDir) ?? workDir
      : workDir
    return (
      path.join(
        getClaudeConfigHomeDir(),
        'projects',
        sanitizePath(memoryProjectRoot),
        AUTO_MEMORY_DIRNAME,
      ) + path.sep
    ).normalize('NFC')
  }

  /**
   * 官方模式下构造 CLI 子进程的 auth env:
   * - CLAUDE_CODE_ENTRYPOINT=claude-desktop 让 CLI 忽略外部残留 ANTHROPIC_* env
   * - 如果 heihei 自管的 oauth.json 里有可用 token,注入 CLAUDE_CODE_OAUTH_TOKEN
   *   让 CLI 直接拿 env 里的 token,不碰 Keychain,绕开 macOS ACL 静默拒绝
   *   (这是 DMG 安装 .app 后 403 "Request not allowed" 的唯一根治方案)
   */
  private async buildOfficialOAuthEnv(): Promise<Record<string, string>> {
    const env: Record<string, string> = {
      CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
    }
    try {
      // deferred import: avoids instantiating the OAuth singleton on every
      // ConversationService construction — only loaded when official mode hits.
      const { heiheiOAuthService } = await import('./heiheiOAuthService.js')
      const token = await heiheiOAuthService.ensureFreshAccessToken()
      if (token) {
        env.CLAUDE_CODE_OAUTH_TOKEN = token
      }
    } catch (err) {
      console.error(
        '[conversationService] ensureFreshAccessToken failed:',
        err instanceof Error ? err.message : err,
      )
    }
    return env
  }

  private async refreshOfficialOAuthTokenBeforeTurn(
    sessionId: string,
    session: SessionProcess,
  ): Promise<void> {
    if (!session.usesOfficialOAuth) return

    let token: string | null = null
    try {
      const { heiheiOAuthService } = await import('./heiheiOAuthService.js')
      token = await heiheiOAuthService.ensureFreshAccessToken()
    } catch (err) {
      console.error(
        '[conversationService] refresh official OAuth token before turn failed:',
        err instanceof Error ? err.message : err,
      )
      return
    }

    if (!token || token === session.officialOAuthToken) return

    session.officialOAuthToken = token
    this.sendSdkMessage(sessionId, {
      type: 'update_environment_variables',
      variables: { CLAUDE_CODE_OAUTH_TOKEN: token },
    })
  }

  private shouldStripInheritedProviderEnv(providerId?: string | null): boolean {
    if (providerId !== undefined) {
      return true
    }

    const configDir =
      process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
    const ccHeiheiDir = path.join(configDir, 'cc-heihei')
    const providersIndexPath = path.join(ccHeiheiDir, 'providers.json')
    const settingsPath = path.join(ccHeiheiDir, 'settings.json')

    if (fs.existsSync(providersIndexPath)) {
      return true
    }

    try {
      const raw = fs.readFileSync(settingsPath, 'utf-8')
      const parsed = JSON.parse(raw) as { env?: Record<string, string> }
      const env = parsed.env ?? {}
      return [
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_AUTH_TOKEN',
        'ENABLE_TOOL_SEARCH',
        'ANTHROPIC_MODEL',
        'ANTHROPIC_DEFAULT_FABLE_MODEL',
        'ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION',
        'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME',
        'ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
        'ANTHROPIC_DEFAULT_SONNET_MODEL',
        'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
        'ANTHROPIC_DEFAULT_OPUS_MODEL',
        'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
        'CC_HEIHEI_SEND_DISABLED_THINKING',
        'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
        'CLAUDE_CODE_ATTRIBUTION_HEADER',
        'CLAUDE_CODE_MODEL_CONTEXT_WINDOWS',
        OPENAI_OAUTH_PROVIDER_ENV_KEY,
        OPENAI_CODEX_OAUTH_FILE_ENV_KEY,
        GROK_OAUTH_PROVIDER_ENV_KEY,
        GROK_OAUTH_FILE_ENV_KEY,
      ].some((key) => typeof env[key] === 'string' && env[key]!.trim().length > 0)
    } catch {
      return false
    }
  }

  /**
   * 只有当用户处于"官方"模式(没有激活任何自定义 provider)时,才把 CLI 标记为
   * managed-OAuth。激活自定义 provider 时 settings.json 里有 ANTHROPIC_AUTH_TOKEN;
   * 这种情况下 CLI 必须按 token 路径走第三方 endpoint,不能被 managed 规则
   * 强制切 OAuth。
   *
   * 默认 (读不到 settings.json) 按"官方"处理 — 即使用户从未用过 cc-heihei
   * provider 管理,也希望官方 OAuth 能正常工作。
   */
  private shouldMarkManagedOAuth(providerId?: string | null): boolean {
    if (providerId === null) {
      return true
    }
    if (typeof providerId === 'string') {
      return false
    }

    const configDir =
      process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
    const settingsPath = path.join(configDir, 'cc-heihei', 'settings.json')
    try {
      const raw = fs.readFileSync(settingsPath, 'utf-8')
      const parsed = JSON.parse(raw) as { env?: Record<string, string> }
      const env = parsed.env ?? {}
      if (env[OPENAI_OAUTH_PROVIDER_ENV_KEY] === '1') {
        return false
      }
      if (env[GROK_OAUTH_PROVIDER_ENV_KEY] === '1') {
        return false
      }
      const hasProviderEnv = [
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_BASE_URL',
      ].some(
        (key) =>
          typeof env[key] === 'string' && env[key]!.trim().length > 0,
      )
      return !hasProviderEnv
    } catch {
      return true
    }
  }

  private resolveCliArgs(baseArgs: string[]): string[] {
    const launcher = resolveClaudeCliLauncher({
      cliPath: process.env.CLAUDE_CLI_PATH,
      execPath: process.execPath,
    })

    if (!launcher) {
      if (process.platform === 'win32') {
        return [
          process.execPath,
          '--preload',
          path.resolve(import.meta.dir, '../../../preload.ts'),
          path.resolve(import.meta.dir, '../../entrypoints/cli.tsx'),
          ...baseArgs,
        ]
      }
      return [path.resolve(import.meta.dir, '../../../bin/claude-heihei'), ...baseArgs]
    }

    return buildClaudeCliArgs(launcher, baseArgs, process.env.CLAUDE_APP_ROOT)
  }

  private clearStaleLock(sessionId: string): boolean {
    const lockDir = path.join(
      process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
      '.lock',
    )
    const lockFile = path.join(lockDir, sessionId)
    if (!fs.existsSync(lockFile)) {
      return false
    }

    try {
      fs.unlinkSync(lockFile)
      return true
    } catch {
      return false
    }
  }

  private buildStartupError(
    sessionId: string,
    exitCode: number,
  ): ConversationStartupError {
    const session = this.sessions.get(sessionId)
    const capturedOutput = this.buildCapturedProcessOutputDetail(session)
    const recentMessages = session?.sdkMessages ?? []
    const resultMessage = [...recentMessages]
      .reverse()
      .find((msg) => msg?.type === 'result' && msg.is_error)
    const assistantApiError = [...recentMessages]
      .reverse()
      .find((msg) => this.isAssistantApiErrorMessage(msg))
    const authStatus = [...recentMessages]
      .reverse()
      .find((msg) => msg?.type === 'auth_status')
    const detail =
      this.extractStartupDetail(resultMessage) ||
      this.extractAssistantApiErrorDetail(assistantApiError) ||
      this.extractStartupDetail(authStatus) ||
      capturedOutput

    if (
      /(not logged in|run \/login|sign in again|login required|unauthenticated|logged_out)/i.test(
        detail,
      )
    ) {
      return new ConversationStartupError(
        'Desktop chat could not start because Claude CLI is not authenticated. Run `./bin/claude-heihei /login` or provide valid API credentials, then retry.',
        'CLI_AUTH_REQUIRED',
      )
    }

    if (/session id .*already in use/i.test(detail)) {
      return new ConversationStartupError(
        `Session ${sessionId} is already in use by another CLI process or transcript.`,
        'CLI_SESSION_CONFLICT',
        true,
      )
    }

    const normalizedDetail = detail.trim()
    if (normalizedDetail) {
      return new ConversationStartupError(
        `CLI exited during startup (code ${exitCode}): ${normalizedDetail}`,
        'CLI_START_FAILED',
        true,
        exitCode,
      )
    }

    // SIGTERM/SIGKILL 且无任何输出：进程是被外部停止的（典型：预热会话在
    // 首次使用前被空闲回收器 stopSession 回收），不是崩溃。按 info 上报，
    // 不进 runtime-errors.log，避免把设计内回收伪装成"启动失败"误导排障
    // （2026-09 外部用户据此误判员工会话 prewarm 故障）。
    if (cliExitSeverity(exitCode) === 'info') {
      const signal = exitCode === 143 ? 'SIGTERM' : 'SIGKILL'
      return new ConversationStartupError(
        `CLI was stopped before startup completed (code ${exitCode}, ${signal}); ` +
          'commonly the prewarm idle reaper reclaiming an unused prewarmed session. This is not a crash.',
        'CLI_START_FAILED',
        true,
        exitCode,
      )
    }

    return new ConversationStartupError(
      `CLI exited during startup with code ${exitCode}; no CLI stderr/stdout or SDK error payload was captured before exit.`,
      'CLI_START_FAILED',
      true,
      exitCode,
    )
  }

  private buildRuntimeExitMessage(sessionId: string, exitCode: number): string {
    const session = this.sessions.get(sessionId)
    const capturedOutput = this.buildCapturedProcessOutputDetail(session)
    const recentMessages = session?.sdkMessages ?? []
    const resultMessage = [...recentMessages]
      .reverse()
      .find((msg) => msg?.type === 'result' && msg.is_error)
    const assistantApiError = [...recentMessages]
      .reverse()
      .find((msg) => this.isAssistantApiErrorMessage(msg))
    const authStatus = [...recentMessages]
      .reverse()
      .find((msg) => msg?.type === 'auth_status')
    const detail =
      this.extractStartupDetail(resultMessage) ||
      this.extractAssistantApiErrorDetail(assistantApiError) ||
      this.extractStartupDetail(authStatus) ||
      capturedOutput

    return detail
      ? `CLI process exited unexpectedly (code ${exitCode}): ${detail}`
      : `CLI process exited unexpectedly with code ${exitCode}; output pipes drained but nothing was captured — the CLI likely crashed before writing anything (runtime-level failure, e.g. Bun abort), no CLI stderr/stdout or SDK error payload was captured before exit.`
  }

  private buildCapturedProcessOutputDetail(
    session: SessionProcess | undefined,
  ): string {
    if (!session) return ''

    const stderrText = (session.stderrLines ?? []).join('\n').trim()
    const stdoutText = (session.stdoutLines ?? []).join('\n').trim()

    if (stderrText && stdoutText) {
      return `stderr:\n${stderrText}\nstdout:\n${stdoutText}`
    }

    return stderrText || stdoutText
  }

  // ── v1.7 结构拆分第①批：诊断文本函数搬到 conversation/startupDiagnostics.ts。
  // 同名类字段委托，调用点与 this 绑定语义不变。依赖实例状态的两个
  // （buildStartupError / buildRuntimeExitMessage）留在本类，搬走必改签名。
  private redactProcessOutput = redactProcessOutput

  private extractStartupDetail = extractStartupDetail

  private isAssistantApiErrorMessage = isAssistantApiErrorMessage

  private extractAssistantApiErrorDetail = extractAssistantApiErrorDetail

  private extractAssistantText = extractAssistantText

  private extractSdkErrorEvent = extractSdkErrorEvent

  private summarizeSdkMessages = summarizeSdkMessages

  private isSafeSdkStatus = isSafeSdkStatus

  private sdkErrorCategory = sdkErrorCategory

  // ── v1.7 结构拆分第①批：附件落盘子系统搬到 conversation/attachments.ts，
  // 同样用类字段委托，调用点零改动。
  private buildUserContent = buildUserContent

  private materializeAttachments = materializeAttachments

  private parseAttachmentData = parseAttachmentData

  private materializeImageAttachment = materializeImageAttachment

  private readImageAttachmentPayload = readImageAttachmentPayload

  private shouldInlineImageAttachment = shouldInlineImageAttachment

  private writeUploadAttachment = writeUploadAttachment

  private normalizeImageExtension = normalizeImageExtension

  private replaceFileExtension = replaceFileExtension

  private getAttachmentExtension = getAttachmentExtension

  private sanitizeAttachmentName = sanitizeAttachmentName

  private getSdkTokenFromUrl(sdkUrl: string): string {
    const url = new URL(sdkUrl)
    return url.searchParams.get('token') || ''
  }
}

function controlRequestAbortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new DOMException('The operation was aborted', 'AbortError')
}

function waitForControlPoll(timeoutMs: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, timeoutMs))
  if (signal.aborted) return Promise.reject(controlRequestAbortReason(signal))

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', handleAbort)
      resolve()
    }, timeoutMs)
    const handleAbort = () => {
      clearTimeout(timeout)
      reject(controlRequestAbortReason(signal))
    }
    signal.addEventListener('abort', handleAbort, { once: true })
    if (signal.aborted) handleAbort()
  })
}

function normalizeSessionPermissionUpdates(
  suggestions: unknown[] | undefined,
  toolName: string,
) {
  if (Array.isArray(suggestions) && suggestions.length > 0) {
    return suggestions.map((suggestion) => {
      if (!suggestion || typeof suggestion !== 'object') {
        return suggestion
      }
      return {
        ...suggestion,
        destination: 'session',
      }
    })
  }

  return [
    {
      type: 'addRules',
      rules: [{ toolName }],
      behavior: 'allow',
      destination: 'session',
    },
  ]
}

export const conversationService = new ConversationService()
