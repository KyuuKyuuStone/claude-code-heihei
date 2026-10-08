/**
 * Session Service — 会话文件的读写操作封装
 *
 * 读写 CLI 持久化在 ~/.claude/projects/{sanitized_path}/{sessionId}.jsonl 的会话数据，
 * 确保 Desktop App 与 CLI 的数据完全互通。
 */

import { readTranscriptCached } from './session/transcriptReadCache.js'
import { createReadStream, type Stats } from 'node:fs'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { ApiError } from '../middleware/errorHandler.js'
import type { FileHistorySnapshot } from '../../utils/fileHistory.js'
// v1.7 结构拆分（sessionService 第③批）：findCanonicalGitRoot 的唯一使用者
// resolveProjectRootFromSessionMetadata 已搬走，本文件不再需要该导入。
import { calculateUSDCost, MODEL_COSTS } from '../../utils/modelCost.js'
import {
  getModelMaxOutputTokens,
} from '../../utils/context.js'
import {
  hasMediaInput,
} from '../../utils/contextBudget.js'
import { getCanonicalName } from '../../utils/model/model.js'
import {
  resolveSessionWorkspaceLaunch,
  type CreateSessionRepositoryOptions,
  type PreparedSessionWorkspace,
} from './repositoryLaunchService.js'
import { registerFilesystemAccessRoot } from './filesystemAccessRoots.js'
import { normalizeDriveRootPathForPlatform } from './windowsDrivePath.js'
// v1.5.0 C11：会话摘要的持久化索引（跨重启复用 mtime+size 未变的摘要）
import {
  sessionSummaryIndexStore,
  type SessionUsageTotals,
} from './sessionSummaryIndexStore.js'
// v1.5.0 C12：会话列表失效信号（ws 层订阅后广播给 _events 通道）
import { emitCollabPush } from '../../collaboration/collabPushSignals.js'
import {
  roughTokenCountEstimationForMessage,
} from '../../services/tokenEstimation.js'
import { ProviderService } from './providerService.js'
import { TranscriptDerivation } from './transcriptDerivation.js'
import type {
  TranscriptContextEstimate,
  TranscriptMetadataSnapshot,
  TranscriptUsageSnapshot,
} from './transcriptDerivation.js'
// B2 族①：3 个类型的定义点随族迁到 ./transcriptDerivation.ts —— 本文件按名再导出
// （导出面零变化），并以 import type 引用（族② :2191-2193 与类型 :259-261 仍在使用）。
export type {
  TranscriptContextEstimate,
  TranscriptMetadataSnapshot,
  TranscriptUsageSnapshot,
} from './transcriptDerivation.js'
import { reduceTranscript } from './localIndex/transcriptReducer.js'
import {
  extractTitle,
  isVisibleTranscriptMessageEntry,
  shouldHideTranscriptEntry,
} from './session/transcriptEntries.js'
// normalizeMessageUsage 随第⑤批搬到 messageConversion.ts 并导出；它仍被本文件
// 红灯段 accumulateUsageFromLine 使用，故以值导入引回（门面导出面零变化）。
import {
  entriesToMessages,
  entryToMessage,
  normalizeMessageUsage,
} from './session/messageConversion.js'
// v1.7 结构拆分（sessionService 第⑥批 · 纯移动）：JSONL 读写与 Agent 子链装载。
// 除 loadSubagentToolMessages（无组外调用点，未留委托）外，其余 8 个方法以同名
// 类字段委托保留，门面 51 处 this.xxx( 调用点文本一行未改。
import {
  appendJsonlEntry,
  appendSubagentToolMessages,
  getConfigDir,
  getProjectsDir,
  readJsonlFile,
  sanitizePath,
  streamJsonlFile,
  subagentTranscriptPath,
} from './session/jsonlStorage.js'
// v1.7 结构拆分（sessionService 第⑦批 · 纯移动）：workspace 可用性判定组。
// 3 个方法以同名类字段委托保留（门面 6 处 this.xxx( 调用点文本一行未改）；
// 另 3 个无组外调用点，未导入。SessionWorkspaceState 是门面导出类型，未搬动。
import {
  createCachedPathExists,
  pathExists,
  resolveWorkspaceAvailability,
} from './session/workspaceAvailability.js'
// v1.7 结构拆分（第⑧批 · 纯移动 · 收口批）：零散纯工具。两名皆有组外调用点，
// 均以同名类字段委托保留；新模块零 import、纯函数。
import { formatCost, isValidSessionId } from './session/sessionUtils.js'
import type {
  PersistedWorktreeSession,
  SessionListSummary,
  TranscriptChunk,
  TranscriptProjection,
} from './localIndex/types.js'
import { localIndexCoordinator } from './localIndex/coordinator.js'
import { readSessionEntriesByLocator } from './localIndex/sessionEntries.js'
import type {
  IndexedSessionRow,
  IndexedSessionSearchCandidate,
  LocalIndexGateway,
  SessionFileMatch,
} from './localIndex/sessionIndex.js'
import type { LocalIndexStatus } from './localIndex/types.js'
import { diagnosticsService } from './diagnosticsService.js'
// v1.7 结构拆分（sessionService 第①批 · 纯移动）：转录内容分类与任务通知解析。
// 下面 4 个常量只被这 10 个函数使用；SessionTaskNotification 是门面导出类型，
// 新模块以 import type 引用（类型擦除，不引入运行时循环）。
import {
  decodeXmlText,
  extractTaskNotificationXml,
  extractTextBlocks,
  isSyntheticNoResponseAssistant,
  isSyntheticUserInterruption,
  isTaskNotificationContent,
  isToolResultContent,
  parsePersistedTaskNotification,
  parseTaskNotificationContent,
  readXmlTag,
} from './session/transcriptContent.js'
// v1.7 结构拆分（sessionService 第②批 · 纯移动）：Agent 子链与 Goal 本地命令解析。
// RawEntry / ContentBlock 原是门面本地未导出类型，随本批搬到该模块、再以 import type
// 引用回来（门面导出面不变；类型擦除，不产生运行时循环）。
import {
  extractAgentIdFromResultText,
  extractAgentToolUseId,
  extractAgentToolUseIdsFromMessage,
  extractTextFromContent,
  goalLocalCommandEntryToMessage,
  isGoalLocalCommandEntry,
  isGoalLocalCommandOutput,
} from './session/transcriptAgents.js'
import type { ContentBlock, RawEntry } from './session/transcriptAgents.js'
// v1.7 结构拆分（sessionService 第③批 · 纯移动）：会话条目元数据解析。
// ProviderContextWindowHint 原是门面本地未导出类型，随本批搬到该模块、再以 import type
// 引用回来（门面导出面不变；类型擦除，不产生运行时循环）。desanitizePath 原理是门面
// public 方法，搬走后以同名 public 字段委托保留（门面另有 3 处组外调用点）。
// VALID_SESSION_PERMISSION_MODES 搬走后仍被门面 5 处使用，随值导入回来。
import {
  applyRuntimeContextMetadata,
  countTranscriptMessages,
  desanitizePath,
  resolvePermissionModeFromEntries,
  resolveProjectRootFromEntries,
  resolveProjectRootFromSessionMetadata,
  resolveRepositoryFromEntries,
  resolveRuntimeContextMetadataFromEntries,
  resolveTranscriptModifiedAtFromEntries,
  resolveWorkDirFromEntries,
  resolveWorktreeSessionFromEntries,
  VALID_SESSION_PERMISSION_MODES,
} from './session/sessionEntryMetadata.js'
import type { ProviderContextWindowHint } from './session/sessionEntryMetadata.js'

// ============================================================================
// Types
// ============================================================================

export type SessionListItem = {
  id: string
  title: string
  createdAt: string
  modifiedAt: string
  messageCount: number
  projectPath: string
  projectRoot: string | null
  workDir: string | null
  workDirExists: boolean
  workspaceState: SessionWorkspaceState
  permissionMode?: string
  runtimeProviderId?: string | null
  runtimeModelId?: string
  effortLevel?: string
}

export type SessionWorkspaceState = 'available' | 'worktree_removed' | 'missing'

export type SessionListShadowComparison = {
  matched: boolean
  fileTotal: number
  indexedTotal: number
  fileCount: number
  indexedCount: number
  differenceCount: number
  fieldHashes: Array<{
    field: string
    fileHash: string
    indexedHash: string
  }>
}

export type SessionServiceLocalIndexOptions = {
  now?: () => number
  indexFailureCooldownMs?: number
  shadowComparisonMinIntervalMs?: number
  recordShadowComparison?: (comparison: SessionListShadowComparison) => void
  targetedEntryReader?: typeof readSessionEntriesByLocator
  sessionListCacheMaxEntries?: number
  sessionListSummaryCacheMaxEntries?: number
}

export type SessionEntriesAtLinesResult = {
  entries: Array<{ entry: Record<string, unknown>; lineNumber: number }>
  bytesRead: number
  rangesRead: number
}

export type IndexedSessionSearchMetadata = {
  title: string
  modifiedAt: string
  workDir: string | null
  projectPath: string
  sourceSnapshot?: {
    dev: number
    ino: number
    size: number
    mtimeMs: number
    ctimeMs: number
  }
}

export type DeleteSessionFailure = {
  sessionId: string
  message: string
  code?: string
}

export type DeleteSessionsResult = {
  successes: string[]
  failures: DeleteSessionFailure[]
}

export type SessionDetail = SessionListItem & {
  messages: MessageEntry[]
}

export type SessionLaunchInfo = {
  filePath: string
  projectDir: string
  workDir: string
  repository?: PreparedSessionWorkspace['repository']
  worktreeSession?: PersistedWorktreeSession | null
  transcriptMessageCount: number
  customTitle: string | null
  permissionMode?: string
  runtimeProviderId?: string | null
  runtimeModelId?: string
  effortLevel?: string
}

// v1.7 结构拆分（sessionService 第③批）：ProviderContextWindowHint 随会话条目
// 元数据解析方法搬到 ./session/sessionEntryMetadata.ts，本文件改为 import type
// （仍不对外导出；门面 :2166/:2318/:2377/:2510 等使用点不变）。

export type SessionInspectionTranscriptSnapshot = {
  launchInfo: SessionLaunchInfo
  metadata: TranscriptMetadataSnapshot
  usage: TranscriptUsageSnapshot | null
  contextEstimate: TranscriptContextEstimate | null
}

export type TrimSessionResult = {
  removedCount: number
  removedMessageIds: string[]
}

export type MessageUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export type MessageEntry = {
  id: string
  type: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result'
  content: unknown
  toolUseResult?: unknown
  timestamp: string
  model?: string
  usage?: MessageUsage
  parentUuid?: string
  parentToolUseId?: string
  isSidechain?: boolean
}

export type SessionTaskNotification = {
  taskId: string
  toolUseId: string
  status: 'completed' | 'failed' | 'stopped'
  summary?: string
  result?: string
  outputFile?: string
  timestamp?: string
}


// v1.7 结构拆分（sessionService 第②批）：RawEntry 随 Agent 子链 / Goal 本地命令
// 解析方法搬到 ./session/transcriptAgents.ts，本文件改为 import type（仍不对外导出）。

/**
 * 摘要取不到时的兜底（v1.5.0 花名册高危修复）：**仅在文件存在、摘要这一步
 * 失败**时使用——让花名册条目照常显示（title 退化为 id 前缀、workDir 未知），
 * 而不是因为一次 IO 抖动被当成「会话已删除」删掉。
 */
function buildFallbackSessionListSummary(sessionId: string): SessionListSummary {
  const now = new Date().toISOString()
  return {
    title: sessionId.slice(0, 8),
    createdAt: now,
    modifiedAt: now,
    messageCount: 0,
    workDir: null,
  }
}

/** 全文件 token 用量累加器（窗口扫描顺带累加，v1.5.0） */
type UsageAccumulator = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

type SessionListSummaryCacheEntry = {
  mtimeMs: number
  size: number
  summary: SessionListSummary
}

const DEFAULT_SESSION_LIST_CACHE_MAX_ENTRIES = 16
const DEFAULT_SESSION_LIST_SUMMARY_CACHE_MAX_ENTRIES = 20_000

// v1.7 结构拆分（sessionService 第③批）：VALID_SESSION_PERMISSION_MODES 搬到
// ./session/sessionEntryMetadata.ts 并 export，本文件改为值导入（门面 :722/:2682/
// :3719/:3941/:4023 等使用点不变）。
const VALID_SESSION_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

// v1.7 结构拆分（sessionService 第②批）：ContentBlock 同上搬到 transcriptAgents.ts。

// v1.7 结构拆分（sessionService 第①批）：USER_INTERRUPTION_TEXTS /
// NO_RESPONSE_REQUESTED_TEXT / TASK_NOTIFICATION_RE / TASK_NOTIFICATION_BLOCK_RE
// 只被转录内容解析那 10 个方法使用，已随它们搬到 ./session/transcriptContent.js。
const PERSISTED_TASK_NOTIFICATION_ENTRY_TYPE = 'cc-heihei-task-notification'

function safeJsonLength(value: unknown): number {
  if (value === undefined) return 0
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

// ============================================================================
// Service
// ============================================================================

type SharedSessionMutationState = {
  epoch: number
  bypass: {
    completionMarker: string | null
    requiresAdditionalCompletion: boolean
  } | null
}

const sharedSessionMutationStates = new WeakMap<LocalIndexGateway, SharedSessionMutationState>()

function getSharedSessionMutationState(
  gateway: LocalIndexGateway,
): SharedSessionMutationState {
  const existing = sharedSessionMutationStates.get(gateway)
  if (existing) return existing
  const created: SharedSessionMutationState = { epoch: 0, bypass: null }
  sharedSessionMutationStates.set(gateway, created)
  return created
}

export class SessionService {
  private providerService = new ProviderService()

  private readonly localIndexGateway: LocalIndexGateway
  private readonly now: () => number
  private readonly indexFailureCooldownMs: number
  private readonly shadowComparisonMinIntervalMs: number
  private readonly recordShadowComparison: (comparison: SessionListShadowComparison) => void
  private readonly targetedEntryReader: typeof readSessionEntriesByLocator
  private indexFailureCooldownUntil = 0
  private observedSharedMutationEpoch: number
  private lastShadowComparisonSignature: string | null = null
  private lastShadowComparisonRecordedAt = Number.NEGATIVE_INFINITY

  private readonly sessionListCacheTtlMs = 5_000
  private readonly sessionListCacheMaxEntries: number
  private readonly sessionListSummaryCacheMaxEntries: number
  private readonly sessionListCache = new Map<string, {
    expiresAt: number
    result: { sessions: SessionListItem[]; total: number }
  }>()
  private readonly sessionListRequests = new Map<
    string,
    Promise<{ sessions: SessionListItem[]; total: number }>
  >()
  private sessionListCacheGeneration = 0
  private readonly sessionListSummaryCache = new Map<string, SessionListSummaryCacheEntry>()
  private readonly sessionListSummaryRequests = new Map<string, Promise<SessionListSummary>>()
  private activeSessionListCacheScope: string | null = null

  constructor(
    localIndexGateway: LocalIndexGateway = localIndexCoordinator,
    options: SessionServiceLocalIndexOptions = {},
  ) {
    this.localIndexGateway = localIndexGateway
    this.observedSharedMutationEpoch = getSharedSessionMutationState(localIndexGateway).epoch
    this.now = options.now ?? Date.now
    this.indexFailureCooldownMs = options.indexFailureCooldownMs ?? 5_000
    this.shadowComparisonMinIntervalMs = options.shadowComparisonMinIntervalMs ?? 30_000
    this.sessionListCacheMaxEntries = this.normalizeCacheCapacity(
      options.sessionListCacheMaxEntries,
      DEFAULT_SESSION_LIST_CACHE_MAX_ENTRIES,
    )
    this.sessionListSummaryCacheMaxEntries = this.normalizeCacheCapacity(
      options.sessionListSummaryCacheMaxEntries,
      DEFAULT_SESSION_LIST_SUMMARY_CACHE_MAX_ENTRIES,
    )
    this.recordShadowComparison = options.recordShadowComparison ?? ((comparison) => {
      void diagnosticsService.recordEvent({
        type: 'local_index_session_shadow_comparison',
        severity: comparison.matched ? 'info' : 'warn',
        summary: comparison.matched
          ? 'Local session index shadow comparison matched'
          : 'Local session index shadow comparison differed',
        details: comparison,
      })
    })
    this.targetedEntryReader = options.targetedEntryReader ?? readSessionEntriesByLocator
  }

  private normalizeCacheCapacity(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? value
      : fallback
  }

  private sessionListCacheKey(options: {
    project?: string
    limit?: number
    offset?: number
  } | undefined, scope = this.getConfigDir()): string {
    return JSON.stringify({
      scope,
      project: options?.project ?? null,
      limit: options?.limit ?? 50,
      offset: options?.offset ?? 0,
    })
  }

  private cloneSessionListResult(result: { sessions: SessionListItem[]; total: number }): { sessions: SessionListItem[]; total: number } {
    return {
      total: result.total,
      sessions: result.sessions.map((session) => ({ ...session })),
    }
  }

  private invalidateSessionListCache(): void {
    this.sessionListCache.clear()
    this.sessionListCacheGeneration += 1
    const sharedState = getSharedSessionMutationState(this.localIndexGateway)
    sharedState.epoch += 1
    sharedState.bypass = this.readIndexMutationBypass()
    this.observedSharedMutationEpoch = sharedState.epoch
    // v1.5.0 C12：会话列表已变 → 广播失效信号（带单调递增 epoch）。ws 层订阅后
    // 做 250ms 合并再广播给 _events 订阅方；无订阅者时是 no-op。
    emitCollabPush({ kind: 'session_list', epoch: sharedState.epoch })
  }

  private prepareSessionListCaches(scope: string): void {
    if (this.activeSessionListCacheScope !== scope) {
      this.sessionListCache.clear()
      this.sessionListSummaryCache.clear()
      this.sessionListCacheGeneration += 1
      this.activeSessionListCacheScope = scope
    }

    const now = this.now()
    for (const [key, entry] of this.sessionListCache) {
      if (entry.expiresAt <= now) this.sessionListCache.delete(key)
    }
  }

  private touchSessionListCacheEntry(
    key: string,
    entry: { expiresAt: number; result: { sessions: SessionListItem[]; total: number } },
  ): void {
    this.sessionListCache.delete(key)
    this.sessionListCache.set(key, entry)
  }

  private enforceSessionListCacheCapacity(): void {
    while (this.sessionListCache.size > this.sessionListCacheMaxEntries) {
      const oldestKey = this.sessionListCache.keys().next().value
      if (oldestKey === undefined) break
      this.sessionListCache.delete(oldestKey)
    }
  }

  private enforceSessionListSummaryCacheCapacity(): void {
    while (this.sessionListSummaryCache.size > this.sessionListSummaryCacheMaxEntries) {
      const oldestKey = this.sessionListSummaryCache.keys().next().value
      if (oldestKey === undefined) break
      this.sessionListSummaryCache.delete(oldestKey)
    }
  }

  private syncSharedMutationEpoch(): void {
    const sharedState = getSharedSessionMutationState(this.localIndexGateway)
    if (sharedState.epoch === this.observedSharedMutationEpoch) return
    this.sessionListCache.clear()
    this.sessionListCacheGeneration += 1
    this.observedSharedMutationEpoch = sharedState.epoch
  }

  private readIndexMutationBypass(): NonNullable<SharedSessionMutationState['bypass']> {
    try {
      const status = this.localIndexGateway.getPublicStatus()
      return {
        completionMarker: status.lastUpdatedAt,
        requiresAdditionalCompletion: status.state === 'building',
      }
    } catch {
      return {
        completionMarker: 'unavailable',
        requiresAdditionalCompletion: true,
      }
    }
  }

  private markIndexReadFailure(): void {
    this.indexFailureCooldownUntil = Math.max(
      this.indexFailureCooldownUntil,
      this.now() + this.indexFailureCooldownMs,
    )
  }

  private getUsableIndexMode(): 'shadow' | 'on' | null {
    let mode: 'off' | 'shadow' | 'on'
    try {
      mode = this.localIndexGateway.getMode()
    } catch {
      this.markIndexReadFailure()
      return null
    }
    if (mode === 'off' || this.now() < this.indexFailureCooldownUntil) return null

    let status: LocalIndexStatus
    try {
      status = this.localIndexGateway.getPublicStatus()
    } catch {
      this.markIndexReadFailure()
      return null
    }

    const sharedState = getSharedSessionMutationState(this.localIndexGateway)
    if (sharedState.bypass !== null) {
      if (
        status.state !== 'ready' ||
        status.lastUpdatedAt === sharedState.bypass.completionMarker
      ) {
        return null
      }
      if (sharedState.bypass.requiresAdditionalCompletion) {
        sharedState.bypass = {
          completionMarker: status.lastUpdatedAt,
          requiresAdditionalCompletion: false,
        }
        return null
      }
      sharedState.bypass = null
    }

    if (status.state === 'off' || status.state === 'degraded') return null
    try {
      if (!this.localIndexGateway.isSessionScopeReady()) return null
    } catch {
      this.markIndexReadFailure()
      return null
    }
    return mode
  }

  private indexStatusRemainsUsable(): boolean {
    try {
      const status = this.localIndexGateway.getPublicStatus()
      return status.state !== 'off' && status.state !== 'degraded'
    } catch {
      return false
    }
  }

  private cloneSessionListSummary(summary: SessionListSummary): SessionListSummary {
    return {
      ...summary,
      repository: summary.repository ? { ...summary.repository } : undefined,
      worktreeSession: summary.worktreeSession
        ? { ...summary.worktreeSession }
        : summary.worktreeSession,
    }
  }

  // v1.7 结构拆分（sessionService 第③批）：latestTimestamp 搬到
  // ./session/sessionEntryMetadata.ts。它在本文件**组外零调用点**（唯一调用者
  // resolveTranscriptModifiedAtFromEntries 同批搬走），故不留委托字段以免死代码。

  private metadataMatchesLaunchInfo(
    launchInfo: SessionLaunchInfo | null,
    metadata: {
      workDir: string
      repository?: PreparedSessionWorkspace['repository']
      permissionMode?: string
      runtimeProviderId?: string | null
      runtimeModelId?: string
      effortLevel?: string
    },
  ): boolean {
    if (!launchInfo) return false
    if (normalizeDriveRootPathForPlatform(launchInfo.workDir) !== metadata.workDir) {
      return false
    }
    if (
      JSON.stringify(launchInfo.repository ?? null) !==
      JSON.stringify(metadata.repository ?? null)
    ) {
      return false
    }
    if (
      metadata.permissionMode &&
      VALID_SESSION_PERMISSION_MODES.has(metadata.permissionMode) &&
      launchInfo.permissionMode !== metadata.permissionMode
    ) {
      return false
    }
    if (
      metadata.runtimeProviderId !== undefined &&
      launchInfo.runtimeProviderId !== metadata.runtimeProviderId
    ) {
      return false
    }
    if (metadata.runtimeModelId && launchInfo.runtimeModelId !== metadata.runtimeModelId) {
      return false
    }
    if (
      metadata.effortLevel &&
      VALID_SESSION_EFFORT_LEVELS.has(metadata.effortLevel) &&
      launchInfo.effortLevel !== metadata.effortLevel
    ) {
      return false
    }
    return true
  }

  /** 并发受限的 map（保序）——列表排序键批量读取用，避免数百并发 open 打爆 fd */
  private async mapWithConcurrency<T, R>(
    items: readonly T[],
    concurrency: number,
    fn: (item: T) => Promise<R>,
  ): Promise<R[]> {
    const results = new Array<R>(items.length)
    let cursor = 0
    const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= items.length) return
        results[index] = await fn(items[index]!)
      }
    })
    await Promise.all(workers)
    return results
  }

  /** 排序键逐级扩窗序列（中1）：64KB → 256KB → 1MB */
  private static readonly TAIL_MODIFIED_WINDOW_BYTES: readonly number[] = [
    64 * 1024,
    256 * 1024,
    1024 * 1024,
  ]

  /**
   * v1.5.0 C11：读取会话文件的「内容时间戳」（列表排序键）。
   *
   * 语义与 transcriptReducer 的 modifiedAt（semanticModifiedAt ?? fallbackModifiedAt）
   * 对齐：文件里最后一条 user/assistant 消息（非 isMeta）的 timestamp。
   * 尾窗读取 + 持久缓存（mtime+size 未变零成本命中）。
   *
   * 中1（v1.5.0 第二批）：原实现只读 64KB、找不到就回退 mtime，存在两个**真实
   * 漂移**场景——①窗口内没有任何 user/assistant 条目；②**最后一条 user 行本身
   * 超过 64KB**（大会话的超长 tool_result 完全可能）时该行横跨窗口、窗口内只
   * parse 到更早的条目 → 排序键取到更早的时间戳，刚活跃的大会话在列表中偏后
   * （用户可感：「刚干完活的会话不在顶部」）。现按 64KB→256KB→1MB 逐级扩窗，
   * 仍不能断言可信则**退回一次全量语义扫描**（与 GET /api/sessions 的 modifiedAt
   * 同源）。结果随 mtime+size 进持久索引，所以每个文件最多付一次成本。
   * 主管裁决：不接受近似口径，必须与全量语义一致。
   */
  private async readTailModifiedAt(
    filePath: string,
    stat: Stats,
    projectDir: string,
    scope: string,
  ): Promise<string> {
    await sessionSummaryIndexStore.ensureLoaded()
    const cached = sessionSummaryIndexStore.getTailModifiedAt(filePath, stat.mtimeMs, stat.size)
    if (cached) return cached

    let value: string
    try {
      value = await this.computeSemanticTailModifiedAt(filePath, stat, projectDir, scope)
    } catch {
      // 读失败（ENOENT 等）：按 mtime 降级，不影响列表可用性
      value = stat.mtime.toISOString()
    }
    sessionSummaryIndexStore.setTailModifiedAt(filePath, stat.mtimeMs, stat.size, value)
    return value
  }

  /**
   * 逐级扩窗求「文件内最后一条 user/assistant 的时间戳」；任一级能给出可信结果
   * 即返回。不可信 = latest 为 null（窗口内一条都没有）或末段无法解析（可能是
   * 跨窗超长行被截断）——两者都可能漏掉更晚的条目。
   */
  private async computeSemanticTailModifiedAt(
    filePath: string,
    stat: Stats,
    projectDir: string,
    scope: string,
  ): Promise<string> {
    for (const windowBytes of SessionService.TAIL_MODIFIED_WINDOW_BYTES) {
      const start = Math.max(0, stat.size - windowBytes)
      const { latest, uncertainTail } = await this.scanTailWindow(filePath, start)
      if (!uncertainTail && latest !== null) return latest
      if (start === 0) break // 已覆盖全文：再扩窗不会有新信息
    }
    // 各级窗口都给不出可信键 → 全量语义扫描（走摘要缓存，与列表 API 口径同源）
    const summary = await this.getCachedSessionListSummary(filePath, projectDir, stat, scope)
    return summary.modifiedAt
  }

  /**
   * 扫描 [start, EOF] 区间的行，返回其中最后一条 user/assistant 的 timestamp。
   *
   * uncertainTail：**末段**（到 EOF 的那一段）无法 parse——它可能是跨窗超长行
   * 被截断的片段，也可能是完整的坏行；两种情况都不能断言「窗口内找到的 latest
   * 就是文件内最后一条」，交由调用方扩窗或退回全量。
   * 窗口**首段**的截断半行无需特判：它位于 latest 之前（位置更早），parse 失败
   * 自然跳过，不可能更新排序键。文件以 
 结尾时末段为空串，跳过、不算不确定。
   */
  private async scanTailWindow(
    filePath: string,
    start: number,
  ): Promise<{ latest: string | null; uncertainTail: boolean }> {
    const stream = createReadStream(filePath, { start, encoding: 'utf8' })
    let text = ''
    try {
      for await (const chunk of stream) {
        text += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      }
    } finally {
      stream.destroy()
    }

    const segments = text.split('\n')
    let latest: string | null = null
    let uncertainTail = false
    for (let index = 0; index < segments.length; index += 1) {
      const trimmed = segments[index]!.trim()
      if (!trimmed) continue
      try {
        const entry = JSON.parse(trimmed) as RawEntry & { isMeta?: boolean }
        if (
          (entry.type === 'user' || entry.type === 'assistant') &&
          entry.message?.role &&
          entry.isMeta !== true &&
          typeof entry.timestamp === 'string'
        ) {
          const candidate = Date.parse(entry.timestamp)
          if (Number.isFinite(candidate) && (!latest || candidate > Date.parse(latest))) {
            latest = entry.timestamp
          }
        }
      } catch {
        if (index === segments.length - 1) uncertainTail = true
      }
    }
    return { latest, uncertainTail }
  }

  private async getCachedSessionListSummary(
    filePath: string,
    projectDir: string,
    stat: Stats,
    scope: string,
  ): Promise<SessionListSummary> {
    const cached = this.sessionListSummaryCache.get(filePath)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      this.sessionListSummaryCache.delete(filePath)
      this.sessionListSummaryCache.set(filePath, cached)
      return this.cloneSessionListSummary(cached.summary)
    }

    const requestKey = `${filePath}:${stat.mtimeMs}:${stat.size}`
    const inFlight = this.sessionListSummaryRequests.get(requestKey)
    if (inFlight) {
      return this.cloneSessionListSummary(await inFlight)
    }

    // v1.5.0 C11：持久化摘要索引（跨重启复用）。mtime+size 未变 → 零成本命中，
    // 只有真正变化的文件才走到下面的流式扫描。
    await sessionSummaryIndexStore.ensureLoaded()
    const persisted = sessionSummaryIndexStore.get(filePath, stat.mtimeMs, stat.size)
    if (persisted) {
      const summary = this.cloneSessionListSummary(persisted)
      if (this.activeSessionListCacheScope === scope) {
        this.sessionListSummaryCache.set(filePath, {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          summary: this.cloneSessionListSummary(summary),
        })
        this.enforceSessionListSummaryCacheCapacity()
      }
      return summary
    }

    const request = this.scanSessionListSummary(filePath, projectDir, stat)
    this.sessionListSummaryRequests.set(requestKey, request)
    try {
      const summary = await request
      if (this.activeSessionListCacheScope === scope) {
        this.sessionListSummaryCache.set(filePath, {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          summary: this.cloneSessionListSummary(summary),
        })
        this.enforceSessionListSummaryCacheCapacity()
      }
      // C11：写入持久索引（标脏 + 防抖落盘，不阻塞本次列表返回）
      sessionSummaryIndexStore.set(
        filePath,
        stat.mtimeMs,
        stat.size,
        this.cloneSessionListSummary(summary),
      )
      return this.cloneSessionListSummary(summary)
    } finally {
      if (this.sessionListSummaryRequests.get(requestKey) === request) {
        this.sessionListSummaryRequests.delete(requestKey)
      }
    }
  }

  // --------------------------------------------------------------------------
  // Config helpers
  // --------------------------------------------------------------------------

  // ── v1.7 结构拆分（sessionService 第⑥批）：getConfigDir / getProjectsDir /
  // sanitizePath 已搬到 ./session/jsonlStorage.ts（同批），此处改为同名类字段委托。
  private getConfigDir = getConfigDir

  private getProjectsDir = getProjectsDir

  private sanitizePath = sanitizePath

  // --------------------------------------------------------------------------
  // JSONL parsing
  // --------------------------------------------------------------------------

  // 第⑥批：readJsonlFile 已搬到 ./session/jsonlStorage.ts（同批）。
  private readJsonlFile = readJsonlFile

  private async readTargetedJsonlEntries(
    found: { filePath: string; projectDir: string },
    entryTypes: string[],
  ): Promise<RawEntry[] | null> {
    if (
      this.getUsableIndexMode() !== 'on' ||
      !this.localIndexGateway.getSessionEntryLocators
    ) {
      return null
    }

    const mutationEpoch = getSharedSessionMutationState(this.localIndexGateway).epoch
    try {
      const page = this.localIndexGateway.getSessionEntryLocators(
        found.filePath,
        entryTypes,
      )
      if (!page) {
        this.markIndexReadFailure()
        return null
      }
      const result = await this.targetedEntryReader({
        transcriptPath: found.filePath,
        projectsRoot: this.getProjectsDir(),
        expectedProjectDir: found.projectDir,
        page,
      })
      if (!result) {
        this.markIndexReadFailure()
        return null
      }
      if (
        mutationEpoch !== getSharedSessionMutationState(this.localIndexGateway).epoch ||
        !this.indexStatusRemainsUsable()
      ) {
        return null
      }
      return result.entries as RawEntry[]
    } catch {
      this.markIndexReadFailure()
      return null
    }
  }

  /**
   * Resolve physical JSONL line numbers through verified byte locators.
   * Returns null whenever the index cannot prove an exact, current mapping so
   * callers can preserve their canonical-file behavior.
   */
  async readSessionEntriesAtLines(
    filePath: string,
    lineNumbers: Set<number>,
    entryTypes: string[],
  ): Promise<SessionEntriesAtLinesResult | null> {
    if (
      this.getUsableIndexMode() !== 'on' ||
      !this.localIndexGateway.getSessionEntryLocators
    ) return null

    const projectDir = path.basename(path.dirname(filePath))
    const mutationEpoch = getSharedSessionMutationState(this.localIndexGateway).epoch
    try {
      // Fetch all scalar locators so a ripgrep hit on a non-message entry is
      // distinguishable from an uncovered partial/stale physical line.
      const page = this.localIndexGateway.getSessionEntryLocators(filePath)
      if (!page) return null
      const byLine = new Map(page.entries.map(locator => [locator.jsonlLine, locator]))
      if ([...lineNumbers].some(lineNumber => !byLine.has(lineNumber))) return null

      const allowedTypes = new Set(entryTypes)
      const selected = [...lineNumbers]
        .sort((a, b) => a - b)
        .map(lineNumber => byLine.get(lineNumber)!)
        .filter(locator => allowedTypes.has(locator.entryType))
      const result = await this.targetedEntryReader({
        transcriptPath: filePath,
        projectsRoot: this.getProjectsDir(),
        expectedProjectDir: projectDir,
        page: { source: page.source, entries: selected },
      })
      if (
        !result ||
        mutationEpoch !== getSharedSessionMutationState(this.localIndexGateway).epoch ||
        !this.indexStatusRemainsUsable()
      ) return null

      return {
        entries: result.entries.map((entry, index) => ({
          entry,
          lineNumber: selected[index]!.jsonlLine,
        })),
        bytesRead: result.bytesRead,
        rangesRead: result.rangesRead,
      }
    } catch {
      this.markIndexReadFailure()
      return null
    }
  }

  // 第⑥批：streamJsonlFile 已搬到 ./session/jsonlStorage.ts（同批）。
  private streamJsonlFile = streamJsonlFile

  private async scanSessionListSummary(
    filePath: string,
    projectDir: string,
    stat: { birthtime: Date; mtime: Date },
  ): Promise<SessionListSummary> {
    let projection: TranscriptProjection = {
      summary: {
        title: 'Untitled Session',
        createdAt: stat.birthtime.toISOString(),
        modifiedAt: stat.mtime.toISOString(),
        messageCount: 0,
        workDir: this.desanitizePath(projectDir),
      },
      indexedBytes: 0,
      pendingTailBytes: 0,
      malformedLineCount: 0,
    }
    const stream = createReadStream(filePath)
    let lineSegments: Buffer[] = []
    let lineSegmentsLength = 0
    let lineByteStart = 0
    let bytesRead = 0
    let chunks: TranscriptChunk[] = []

    const flushChunks = () => {
      if (chunks.length === 0) return
      projection = reduceTranscript(chunks, projection)
      chunks = []
    }

    try {
      for await (const data of stream) {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
        const bufferStart = bytesRead
        bytesRead += buffer.length
        let segmentStart = 0

        while (segmentStart < buffer.length) {
          const newlineIndex = buffer.indexOf(0x0a, segmentStart)
          if (newlineIndex === -1) {
            if (lineSegments.length === 0) {
              lineByteStart = bufferStart + segmentStart
            }
            const segment = buffer.subarray(segmentStart)
            lineSegments.push(segment)
            lineSegmentsLength += segment.length
            break
          }

          const finalSegment = buffer.subarray(segmentStart, newlineIndex + 1)
          let line: Buffer
          if (lineSegments.length === 0) {
            line = finalSegment
          } else {
            lineSegments.push(finalSegment)
            lineSegmentsLength += finalSegment.length
            line = Buffer.concat(lineSegments, lineSegmentsLength)
          }
          chunks.push({
            text: line.toString('utf8'),
            byteStart: lineByteStart,
            completeLine: true,
          })
          if (chunks.length >= 256) flushChunks()

          lineSegments = []
          lineSegmentsLength = 0
          segmentStart = newlineIndex + 1
          lineByteStart = bufferStart + segmentStart
        }
      }

      flushChunks()
      if (lineSegmentsLength > 0) {
        const pending = lineSegments.length === 1
          ? lineSegments[0]!
          : Buffer.concat(lineSegments, lineSegmentsLength)
        projection = reduceTranscript([{
          text: pending.toString('utf8'),
          byteStart: lineByteStart,
          completeLine: false,
        }], projection)
      }
    } finally {
      stream.destroy()
    }

    return projection.summary
  }

  /**
   * Resolve a session's display title + lightweight metadata from its JSONL file.
   *
   * Reuses the same title precedence as the session list (custom-title > goal >
   * ai-title > first user message), so global session search shows real titles
   * instead of the raw UUID file name.
   */
  async getSessionTitleAndMeta(filePath: string): Promise<{
    title: string
    modifiedAt: string
    workDir: string | null
    projectPath: string
  }> {
    const stat = await fs.stat(filePath)
    const projectPath = path.basename(path.dirname(filePath))
    const summary = await this.scanSessionListSummary(filePath, projectPath, stat)
    return {
      title: summary.title,
      modifiedAt: summary.modifiedAt,
      workDir: summary.workDir ?? null,
      projectPath,
    }
  }

  async getIndexedSessionSearchMetadata(
    filePaths: string[],
  ): Promise<Map<string, IndexedSessionSearchMetadata> | null> {
    if (this.getUsableIndexMode() !== 'on') return null
    const wanted = new Set(filePaths.map(filePath => path.resolve(filePath)))
    const projects = new Set(filePaths.map(filePath => path.basename(path.dirname(filePath))))
    const mutationEpoch = getSharedSessionMutationState(this.localIndexGateway).epoch
    const result = new Map<string, IndexedSessionSearchMetadata>()
    try {
      for (const project of projects) {
        const page = this.localIndexGateway.listSessions({
          project,
          limit: 2_147_483_647,
          offset: 0,
        })
        for (const session of page.sessions) {
          const transcriptPath = path.resolve(session.transcriptPath)
          if (!wanted.has(transcriptPath)) continue
          result.set(transcriptPath, {
            title: session.title,
            modifiedAt: session.modifiedAt,
            workDir: session.workDir,
            projectPath: session.projectPath,
          })
        }
      }
      if (
        mutationEpoch !== getSharedSessionMutationState(this.localIndexGateway).epoch ||
        !this.indexStatusRemainsUsable()
      ) return null
      return result
    } catch {
      this.markIndexReadFailure()
      return null
    }
  }

  /**
   * Return a complete, filterable session path set for search phase A.
   * Null means the index cannot currently prove completeness, so callers must
   * preserve canonical filesystem scanning.
   */
  async getIndexedSessionSearchCandidates(filters: {
    project?: string
    modifiedAfter?: string
    modifiedBefore?: string
  }): Promise<Map<string, IndexedSessionSearchMetadata> | null> {
    // A date-only canonical search recursively includes nested subagent JSONL
    // files, which are not rows in the main-session table. Project-filtered
    // search already excludes those paths by parent directory, so only that
    // shape can be narrowed without changing historical results.
    if (
      !filters.project ||
      filters.project === '.' ||
      filters.project === '..' ||
      filters.project.includes('/') ||
      filters.project.includes('\\') ||
      path.basename(filters.project) !== filters.project
    ) return null
    if (this.getUsableIndexMode() !== 'on') return null
    const mutationEpoch = getSharedSessionMutationState(this.localIndexGateway).epoch
    try {
      const statusBefore = this.localIndexGateway.getPublicStatus()
      if (
        statusBefore.state !== 'ready' ||
        statusBefore.degradedSources !== 0 ||
        statusBefore.discovered !== statusBefore.indexed
      ) return null

      const modifiedAfterMs = filters.modifiedAfter
        ? Date.parse(filters.modifiedAfter)
        : Number.NEGATIVE_INFINITY
      const modifiedBeforeMs = filters.modifiedBefore
        ? Date.parse(filters.modifiedBefore)
        : Number.POSITIVE_INFINITY
      if (Number.isNaN(modifiedAfterMs) || Number.isNaN(modifiedBeforeMs)) {
        return new Map()
      }

      const findCandidates = this.localIndexGateway.findSearchCandidates
      if (!findCandidates) return null
      const allCandidates = findCandidates.call(this.localIndexGateway, {
        project: filters.project,
      })
      if (!allCandidates) return null
      const candidates = Number.isFinite(modifiedAfterMs) || Number.isFinite(modifiedBeforeMs)
        ? findCandidates.call(this.localIndexGateway, {
            project: filters.project,
            ...(Number.isFinite(modifiedAfterMs) ? { modifiedAfterMs } : {}),
            ...(Number.isFinite(modifiedBeforeMs) ? { modifiedBeforeMs } : {}),
          })
        : allCandidates
      if (!candidates) return null

      const projectsRoot = path.resolve(this.getProjectsDir())
      const projectRoot = path.resolve(projectsRoot, filters.project)
      const projectRelative = path.relative(projectsRoot, projectRoot)
      if (
        projectRelative !== filters.project ||
        projectRelative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(projectRelative)
      ) return null

      const directoryBefore = await fs.stat(projectRoot)
      if (!directoryBefore.isDirectory()) return null
      const directoryEntries = await fs.readdir(projectRoot, { withFileTypes: true })
      const canonicalPaths = new Set(directoryEntries
        .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map(entry => path.resolve(projectRoot, entry.name)))

      const validateCandidates = (
        values: IndexedSessionSearchCandidate[],
      ): Map<string, IndexedSessionSearchMetadata> | null => {
        const validated = new Map<string, IndexedSessionSearchMetadata>()
        for (const session of values) {
          const transcriptPath = path.resolve(session.transcriptPath)
          const expectedPath = path.resolve(
            projectsRoot,
            session.projectPath,
            `${session.id}.jsonl`,
          )
          if (
            !session.projectPath ||
            path.basename(session.projectPath) !== session.projectPath ||
            transcriptPath !== expectedPath ||
            session.projectPath !== filters.project ||
            !Number.isFinite(Date.parse(session.modifiedAt))
          ) return null
          validated.set(transcriptPath, {
            title: session.title,
            modifiedAt: session.modifiedAt,
            workDir: session.workDir,
            projectPath: session.projectPath,
          })
        }
        return validated
      }

      const allValidated = validateCandidates(allCandidates)
      const result = validateCandidates(candidates)
      if (!allValidated || !result) return null
      if (
        canonicalPaths.size !== allValidated.size ||
        [...canonicalPaths].some(transcriptPath => !allValidated.has(transcriptPath))
      ) return null

      const currentFilteredPaths = new Set<string>()
      for (const [transcriptPath, metadata] of allValidated) {
        const snapshot = await fs.stat(transcriptPath)
        if (!snapshot.isFile()) return null
        const sourceSnapshot = {
          dev: snapshot.dev,
          ino: snapshot.ino,
          size: snapshot.size,
          mtimeMs: snapshot.mtimeMs,
          ctimeMs: snapshot.ctimeMs,
        }
        metadata.sourceSnapshot = sourceSnapshot
        const selectedMetadata = result.get(transcriptPath)
        if (selectedMetadata) selectedMetadata.sourceSnapshot = sourceSnapshot
        if (Number.isFinite(modifiedAfterMs) || Number.isFinite(modifiedBeforeMs)) {
          if (
            snapshot.mtimeMs >= modifiedAfterMs &&
            snapshot.mtimeMs <= modifiedBeforeMs
          ) currentFilteredPaths.add(transcriptPath)
        }
      }
      if (Number.isFinite(modifiedAfterMs) || Number.isFinite(modifiedBeforeMs)) {
        if (
          currentFilteredPaths.size !== result.size ||
          [...currentFilteredPaths].some(transcriptPath => !result.has(transcriptPath))
        ) return null
      }

      const directoryAfter = await fs.stat(projectRoot)
      if (
        directoryBefore.dev !== directoryAfter.dev ||
        directoryBefore.ino !== directoryAfter.ino ||
        directoryBefore.size !== directoryAfter.size ||
        directoryBefore.mtimeMs !== directoryAfter.mtimeMs ||
        directoryBefore.ctimeMs !== directoryAfter.ctimeMs
      ) return null

      const statusAfter = this.localIndexGateway.getPublicStatus()
      if (
        mutationEpoch !== getSharedSessionMutationState(this.localIndexGateway).epoch ||
        statusAfter.state !== 'ready' ||
        statusAfter.degradedSources !== 0 ||
        statusAfter.discovered !== statusAfter.indexed ||
        statusAfter.indexed !== statusBefore.indexed ||
        statusAfter.lastUpdatedAt !== statusBefore.lastUpdatedAt
      ) return null
      return result
    } catch {
      this.markIndexReadFailure()
      return null
    }
  }

  // 第⑥批：appendJsonlEntry 已搬到 ./session/jsonlStorage.ts（同批）。
  private appendJsonlEntry = appendJsonlEntry

  // ── v1.7 结构拆分（sessionService 第③批）：会话条目元数据解析 13 个名字搬到
  // ./session/sessionEntryMetadata.ts，此处为其中 11 个保留同名类字段委托。所有调用点
  // （含组外的 getIndexedSessionSearchMetadata / loadSessionList / findSessionFilesFromFiles
  // 等）的 this.xxx(...) 文本一行未改。
  // 规则：只有「门面仍有 this.<名>( 残留调用点」的方法才留委托，无残留者不留（避免死代码）。
  //   · canonicalizeProjectPath、latestTimestamp 门面残留调用点均为 0，故**不留委托**、
  //     也不 import（两者的唯一调用者都在同批搬走的方法体内，现为新模块内部裸调用）；
  //   · desanitizePath 保持 **public** 委托：其 HEAD 形态是无 private 前缀的 public 类方法，
  //     且门面外仍有 2 处生产调用（src/server/api/sessions.ts:1206/:1240）与 4 处测试调用，
  //     加 private 会直接破坏这些调用方。
  private resolveWorkDirFromEntries = resolveWorkDirFromEntries
  private resolveRepositoryFromEntries = resolveRepositoryFromEntries
  private resolvePermissionModeFromEntries = resolvePermissionModeFromEntries
  private resolveTranscriptModifiedAtFromEntries = resolveTranscriptModifiedAtFromEntries
  private resolveRuntimeContextMetadataFromEntries = resolveRuntimeContextMetadataFromEntries
  private applyRuntimeContextMetadata = applyRuntimeContextMetadata
  private resolveWorktreeSessionFromEntries = resolveWorktreeSessionFromEntries
  private resolveProjectRootFromEntries = resolveProjectRootFromEntries
  private resolveProjectRootFromSessionMetadata = resolveProjectRootFromSessionMetadata
  private countTranscriptMessages = countTranscriptMessages
  desanitizePath = desanitizePath

  // --------------------------------------------------------------------------
  // Entry → MessageEntry conversion
  // --------------------------------------------------------------------------

  // ── v1.7 结构拆分（sessionService 第⑤批）：RawEntry → MessageEntry 转换共 3 个
  // 方法搬到 ./session/messageConversion.ts。其中 entryToMessage / entriesToMessages
  // 有组外调用点（loadSubagentToolMessages 1 处、getSessionMessages 系列 5 处，共 6 处），
  // 此处改为同名类字段委托，调用点 this.xxx(...) 文本一行未改；
  // resolveParentToolUseId 的唯一调用点在 entriesToMessages 内部（已随本批搬走），
  // 门面已无组外调用点，**不留死委托**，直接由新模块内部裸调用。
  private entryToMessage = entryToMessage

  // ── v1.7 结构拆分（sessionService 第①批）：转录内容分类与任务通知解析共 10 个
  // 方法搬到 ./session/transcriptContent.ts，此处改为同名类字段委托。组外调用点
  // （shouldHideTranscriptEntry / isGoalLocalCommandEntry / entriesToMessages 等）
  // 的 this.xxx(...) 文本一行未改。
  private extractTextBlocks = extractTextBlocks
  private isSyntheticUserInterruption = isSyntheticUserInterruption
  private isSyntheticNoResponseAssistant = isSyntheticNoResponseAssistant
  private isToolResultContent = isToolResultContent
  private isTaskNotificationContent = isTaskNotificationContent
  private extractTaskNotificationXml = extractTaskNotificationXml
  private decodeXmlText = decodeXmlText
  private readXmlTag = readXmlTag
  private parseTaskNotificationContent = parseTaskNotificationContent
  private parsePersistedTaskNotification = parsePersistedTaskNotification

  // ── v1.7 结构拆分（sessionService 第④批）：转录条目可见性判定与标题提取共 3 个
  // 方法搬到 ./session/transcriptEntries.ts，此处改为同名类字段委托。所有调用点
  // （含组外的 loadSubagentToolMessages / getSessionTitleAndMeta /
  // getIndexedSessionSearchMetadata 等）的 this.xxx(...) 文本一行未改。
  private shouldHideTranscriptEntry = shouldHideTranscriptEntry
  private isVisibleTranscriptMessageEntry = isVisibleTranscriptMessageEntry

  // ── v1.7 结构拆分（sessionService 第②批）：Agent 子链与 Goal 本地命令解析共 9 个
  // 方法搬到 ./session/transcriptAgents.ts，此处改为同名类字段委托。所有调用点
  // （含组外的 entriesToMessages / resolveParentToolUseId / loadSubagentToolMessages
  // 等）的 this.xxx(...) 文本一行未改。
  private isGoalLocalCommandOutput = isGoalLocalCommandOutput
  private isGoalLocalCommandEntry = isGoalLocalCommandEntry
  private goalLocalCommandEntryToMessage = goalLocalCommandEntryToMessage
  private extractAgentToolUseId = extractAgentToolUseId
  private extractAgentToolUseIdsFromMessage = extractAgentToolUseIdsFromMessage
  private extractTextFromContent = extractTextFromContent
  private extractAgentIdFromResultText = extractAgentIdFromResultText
  // 第⑥批：subagentTranscriptPath / loadSubagentToolMessages / appendSubagentToolMessages
  // 已搬到 ./session/jsonlStorage.ts（同批）。其中 loadSubagentToolMessages 的唯一调用点在
  // appendSubagentToolMessages 内部（随之搬走），门面已无组外调用点，**不留死委托**；
  // 另两个有组外调用点，改为同名类字段委托。
  private subagentTranscriptPath = subagentTranscriptPath

  private appendSubagentToolMessages = appendSubagentToolMessages

  // --------------------------------------------------------------------------
  // Title extraction
  // --------------------------------------------------------------------------

  // 第④批：extractTitle 已搬到 ./session/transcriptEntries.ts（同批，委托块见上）。
  private extractTitle = extractTitle

  // --------------------------------------------------------------------------
  // Session file discovery
  // --------------------------------------------------------------------------

  /**
   * Find all .jsonl session files across all project directories.
   * Returns an array of { filePath, projectDir, sessionId }.
   */
  private async discoverSessionFiles(projectFilter?: string, scope = this.getConfigDir()): Promise<
    Array<{ filePath: string; projectDir: string; sessionId: string }>
  > {
    const projectsDir = path.join(scope, 'projects')
    let projectDirs: string[]

    try {
      projectDirs = await fs.readdir(projectsDir)
    } catch {
      return []
    }

    // Optionally filter to a specific project
    if (projectFilter) {
      const sanitized = this.sanitizePath(normalizeDriveRootPathForPlatform(projectFilter))
      projectDirs = projectDirs.filter((d) => d === sanitized)
    }

    const results: Array<{ filePath: string; projectDir: string; sessionId: string }> = []

    for (const dir of projectDirs) {
      const dirPath = path.join(projectsDir, dir)

      // Ensure it's a directory
      try {
        const stat = await fs.stat(dirPath)
        if (!stat.isDirectory()) continue
      } catch {
        continue
      }

      let files: string[]
      try {
        files = await fs.readdir(dirPath)
      } catch {
        continue
      }

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue
        const sessionId = file.replace('.jsonl', '')
        results.push({
          filePath: path.join(dirPath, file),
          projectDir: dir,
          sessionId,
        })
      }
    }

    return results
  }

  // v1.7 结构拆分（sessionService 第③批）：desanitizePath 搬到
  // ./session/sessionEntryMetadata.ts；本文件保留 public 同名委托（见上方委托块），
  // 门面若干组外调用点的调用文本未改。

  /**
   * Find the .jsonl file for a given session ID.
   * Searches across all project directories since sessions may belong to any project.
   */
  private async validateIndexedTranscriptPath(
    filePath: string,
    projectDir: string,
    sessionId: string,
    projectsRoot: string,
  ): Promise<Stats> {
    const invalid = (): Error & { code: string } => Object.assign(
      new Error('Indexed transcript path failed scope validation'),
      { code: 'LOCAL_INDEX_PATH_INVALID' },
    )
    if (
      !this.isValidSessionId(sessionId) ||
      !projectDir ||
      path.basename(projectDir) !== projectDir ||
      path.basename(filePath) !== `${sessionId}.jsonl` ||
      path.basename(path.dirname(filePath)) !== projectDir
    ) {
      throw invalid()
    }

    const projectsDir = this.getProjectsDir()
    const expectedPath = path.join(projectsDir, projectDir, `${sessionId}.jsonl`)
    const indexedRealPath = await fs.realpath(filePath)
    const expectedRealPath = path.resolve(expectedPath) === path.resolve(filePath)
      ? indexedRealPath
      : await fs.realpath(expectedPath)
    const relativePath = path.relative(projectsRoot, indexedRealPath)
    if (
      expectedRealPath !== indexedRealPath ||
      relativePath === '..' ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      throw invalid()
    }

    const stat = await fs.stat(indexedRealPath)
    if (!stat.isFile()) throw invalid()
    return stat
  }

  private async findSessionFiles(
    sessionId: string
  ): Promise<Array<{ filePath: string; projectDir: string }>> {
    this.syncSharedMutationEpoch()
    if (!this.isValidSessionId(sessionId)) {
      return []
    }

    const indexMode = this.getUsableIndexMode()
    if (indexMode === 'on') {
      const indexedMutationEpoch = getSharedSessionMutationState(this.localIndexGateway).epoch
      try {
        const indexedMatches = this.localIndexGateway.findSessionFiles(sessionId)
        if (!this.indexStatusRemainsUsable()) {
          this.markIndexReadFailure()
        } else {
          const projectsRoot = indexedMatches.length > 0
            ? await fs.realpath(this.getProjectsDir())
            : null
          const hydratedMatches: Array<SessionFileMatch & { mtimeMs: number }> = []
          let hydrationFailed = false
          for (const match of indexedMatches) {
            try {
              const stat = await this.validateIndexedTranscriptPath(
                match.filePath,
                match.projectDir,
                sessionId,
                projectsRoot!,
              )
              hydratedMatches.push({ ...match, mtimeMs: stat.mtimeMs })
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                hydrationFailed = true
                break
              }
            }
          }
          if (
            !hydrationFailed &&
            hydratedMatches.length > 0 &&
            indexedMutationEpoch === getSharedSessionMutationState(this.localIndexGateway).epoch
          ) {
            return hydratedMatches
              .sort((a, b) => b.mtimeMs - a.mtimeMs || a.filePath.localeCompare(b.filePath))
              .map(({ filePath, projectDir }) => ({ filePath, projectDir }))
          }
          if (hydrationFailed) this.markIndexReadFailure()
        }
      } catch {
        this.markIndexReadFailure()
      }
    }

    this.syncSharedMutationEpoch()
    return this.findSessionFilesFromFiles(sessionId)
  }

  private async findSessionFilesFromFiles(
    sessionId: string,
  ): Promise<Array<{ filePath: string; projectDir: string }>> {

    const projectsDir = this.getProjectsDir()
    let projectDirs: string[]

    try {
      projectDirs = await fs.readdir(projectsDir)
    } catch {
      return []
    }

    const matches: Array<{ filePath: string; projectDir: string; mtimeMs: number }> = []
    for (const dir of projectDirs) {
      const filePath = path.join(projectsDir, dir, `${sessionId}.jsonl`)
      try {
        const stat = await fs.stat(filePath)
        matches.push({ filePath, projectDir: dir, mtimeMs: stat.mtimeMs })
      } catch {
        continue
      }
    }

    return matches
      .sort((a, b) => b.mtimeMs - a.mtimeMs || a.filePath.localeCompare(b.filePath))
      .map(({ filePath, projectDir }) => ({ filePath, projectDir }))
  }

  async findSessionFile(
    sessionId: string
  ): Promise<{ filePath: string; projectDir: string } | null> {
    return (await this.findSessionFiles(sessionId))[0] ?? null
  }

  /**
   * 单会话列表摘要直查（轻量）：花名册等只需少数已知会话的调用方使用。
   * 避免 listSessions({ limit: 500 }) 的全量摘要扫描——它会先对发现的全部
   * 会话文件逐一 scanSessionListSummary 再切片（冷启动 = 全量扫；活跃会话
   * mtime 一变就整文件重扫），渲染端 20s 花名册轮询曾因此把事件循环打到
   * 分钟级阻塞（v1.4.0 实录花名册请求 120s 超时）。这里复用同一 mtime+size
   * 摘要缓存与 in-flight 去重，只付目标会话一份成本。
   */
  async getSessionListSummaryForSession(sessionId: string): Promise<SessionListSummary | null> {
    const found = await this.findSessionFile(sessionId)
    // 「不存在」只由这一条表达：findSessionFile 连文件都没找到（含目录不可读等，
    // 见 findSessionFiles 的兜底）。
    if (!found) return null
    try {
      const stat = await fs.stat(found.filePath)
      return await this.getCachedSessionListSummary(
        found.filePath,
        found.projectDir,
        stat,
        this.activeSessionListCacheScope ?? this.getConfigDir(),
      )
    } catch {
      // v1.5.0 花名册高危修复：文件**确实存在**（findSessionFile 已定位），只是
      // 摘要这一步失败（索引未就绪、扫描异常、IO 抖动……）。这里以前返回 null，
      // 调用方（花名册 listServants）会把它当成「会话已删除」而永久删除员工
      // 身份——一次瞬时抖动就能清空整个花名册（实测 9 条 servant_removed 挤在
      // 同一毫秒）。改为返回兜底摘要：调用方拿到的是「存在」，只是 title 退化为
      // id 前缀、workDir 未知；真正的删除由显式删除路径清理。
      return buildFallbackSessionListSummary(sessionId)
    }
  }

  // ── v1.7 结构拆分（第⑧批 · sessionService 纯移动收口批）：零散纯工具已搬到
  // ./session/sessionUtils.ts（同批）。两名都有组外调用点，改为同名类字段委托。
  private isValidSessionId = isValidSessionId

  private formatCost = formatCost

  // ── B2 族①（上下文窗口/用量族）已整簇外移到 ./transcriptDerivation.ts ──────────
  // 4 项族外能力经宿主对象注入（箭头惰性读 this.xxx，故字段次序无关、测试接缝仍生效）；
  // 3 个 public 方法以同名类成员委托保留（测试有 spyOn(sessionService, 'getTranscriptContextEstimate')）。
  private transcriptDerivation = new TranscriptDerivation({
    providerService: this.providerService,
    readJsonlFile: (filePath) => this.readJsonlFile(filePath),
    findSessionFile: (sessionId) => this.findSessionFile(sessionId),
    getSessionLaunchInfo: (sessionId) => this.getSessionLaunchInfo(sessionId),
  })

  async getTranscriptMetadata(sessionId: string): Promise<TranscriptMetadataSnapshot | null> {
    return this.transcriptDerivation.getTranscriptMetadata(sessionId)
  }

  async getTranscriptContextEstimate(
    sessionId: string,
  ): Promise<TranscriptContextEstimate | null> {
    return this.transcriptDerivation.getTranscriptContextEstimate(sessionId)
  }

  async getTranscriptUsage(sessionId: string): Promise<TranscriptUsageSnapshot | null> {
    return this.transcriptDerivation.getTranscriptUsage(sessionId)
  }

  // 族②（getInspectionTranscriptSnapshot，:1868/:1897）仍在本文件调用这两个原本私有的
  // 方法 ⇒ 以同名私有成员委托保留，**调用点文本一行未改**（先例：workspace 可用性组）。
  private async getTranscriptContextWindow(
    sessionId: string,
    model: string,
    launchInfo?: ProviderContextWindowHint | null,
  ): Promise<number> {
    return this.transcriptDerivation.getTranscriptContextWindow(sessionId, model, launchInfo)
  }

  private async buildTranscriptContextEstimate(
    sessionId: string,
    latest: {
      model: string
      inputTokens: number
      outputTokens: number
      cacheReadInputTokens: number
      cacheCreationInputTokens: number
    },
    estimatedTokensFromMessages: number,
    transcriptHasMediaInput: boolean,
    launchInfo?: ProviderContextWindowHint | null,
  ): Promise<TranscriptContextEstimate> {
    return this.transcriptDerivation.buildTranscriptContextEstimate(
      sessionId,
      latest,
      estimatedTokensFromMessages,
      transcriptHasMediaInput,
      launchInfo,
    )
  }



  async getInspectionTranscriptSnapshot(sessionId: string): Promise<SessionInspectionTranscriptSnapshot | null> {
    const found = await this.findSessionFile(sessionId)
    if (!found) return null

    let latestWorkDir: string | null = null
    let latestCwd: string | null = null
    let repository: PreparedSessionWorkspace['repository'] | undefined
    let worktreeSession: PersistedWorktreeSession | null | undefined
    let permissionMode: string | undefined
    let runtimeProviderId: string | null | undefined
    let runtimeModelId: string | undefined
    let effortLevel: string | undefined
    let customTitle: string | null = null
    let transcriptMessageCount = 0
    const metadata: TranscriptMetadataSnapshot = {}

    const models = new Map<string, TranscriptUsageSnapshot['models'][number]>()
    let totalCostUSD = 0
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalCacheReadInputTokens = 0
    let totalCacheCreationInputTokens = 0
    let totalWebSearchRequests = 0
    let hasUnknownModelCost = false
    let firstUsageAt: number | null = null
    let lastUsageAt: number | null = null

    let latestContextUsage: {
      model: string
      inputTokens: number
      outputTokens: number
      cacheReadInputTokens: number
      cacheCreationInputTokens: number
    } | null = null
    let estimatedTokensFromMessages = 0
    let transcriptHasMediaInput = false

    await this.streamJsonlFile(found.filePath, (entry) => {
      if (typeof entry.message?.model === 'string') {
        metadata.model = entry.message.model
      }
      if (typeof entry.cwd === 'string') {
        metadata.cwd = entry.cwd
        latestCwd = normalizeDriveRootPathForPlatform(entry.cwd)
      }
      if (typeof entry.version === 'string') {
        metadata.version = entry.version
      }

      if (entry.type === 'session-meta') {
        const record = entry as Record<string, unknown>
        if (typeof record.workDir === 'string') {
          latestWorkDir = normalizeDriveRootPathForPlatform(record.workDir)
        }
        if (
          typeof entry.permissionMode === 'string' &&
          VALID_SESSION_PERMISSION_MODES.has(entry.permissionMode)
        ) {
          permissionMode = entry.permissionMode
        }
        if (record.runtimeProviderId === null || typeof record.runtimeProviderId === 'string') {
          runtimeProviderId = record.runtimeProviderId as string | null
        }
        if (typeof record.runtimeModelId === 'string') {
          runtimeModelId = record.runtimeModelId
        }
        if (
          typeof record.effortLevel === 'string' &&
          VALID_SESSION_EFFORT_LEVELS.has(record.effortLevel)
        ) {
          effortLevel = record.effortLevel
        }
      }

      const candidateRepository = (entry as Record<string, unknown>)?.repository
      if (candidateRepository && typeof candidateRepository === 'object') {
        repository = candidateRepository as PreparedSessionWorkspace['repository']
      }

      if (entry.type === 'worktree-state') {
        if (entry.worktreeSession === null) {
          worktreeSession = null
        } else if (
          entry.worktreeSession &&
          typeof entry.worktreeSession === 'object' &&
          typeof entry.worktreeSession.worktreePath === 'string' &&
          typeof entry.worktreeSession.worktreeName === 'string'
        ) {
          worktreeSession = entry.worktreeSession
        }
      }

      if (entry.type === 'custom-title' && typeof entry.customTitle === 'string') {
        customTitle = entry.customTitle
      }

      if (
        !entry.isMeta &&
        !!entry.message?.role &&
        (entry.type === 'user' || entry.type === 'assistant' || entry.type === 'system')
      ) {
        transcriptMessageCount += 1
      }

      if (
        entry.type === 'user' ||
        entry.type === 'assistant' ||
        entry.type === 'attachment'
      ) {
        estimatedTokensFromMessages += roughTokenCountEstimationForMessage(entry)
        if (!transcriptHasMediaInput && hasMediaInput([entry])) {
          transcriptHasMediaInput = true
        }
      }

      const usage = entry.message?.usage
      const model = entry.message?.model
      if (!usage || typeof model !== 'string') return

      const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0
      const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0
      const cacheReadInputTokens = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0
      const cacheCreationInputTokens = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0
      const webSearchRequests = typeof usage.server_tool_use?.web_search_requests === 'number'
        ? usage.server_tool_use.web_search_requests
        : 0

      latestContextUsage = {
        model,
        inputTokens,
        outputTokens,
        cacheReadInputTokens,
        cacheCreationInputTokens,
      }

      if (
        inputTokens === 0 &&
        outputTokens === 0 &&
        cacheReadInputTokens === 0 &&
        cacheCreationInputTokens === 0 &&
        webSearchRequests === 0
      ) {
        return
      }

      const canonical = getCanonicalName(model)
      if (!Object.prototype.hasOwnProperty.call(MODEL_COSTS, canonical)) {
        hasUnknownModelCost = true
      }

      const costUsage = {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cacheReadInputTokens,
        cache_creation_input_tokens: cacheCreationInputTokens,
        server_tool_use: { web_search_requests: webSearchRequests },
        speed: usage.speed,
      } as Parameters<typeof calculateUSDCost>[1]
      const costUSD = calculateUSDCost(model, costUsage)

      let modelUsage = models.get(model)
      if (!modelUsage) {
        modelUsage = {
          model,
          displayName: canonical,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0,
          costDisplay: '$0.0000',
          contextWindow: 0,
          maxOutputTokens: getModelMaxOutputTokens(model).default,
        }
        models.set(model, modelUsage)
      }

      modelUsage.inputTokens += inputTokens
      modelUsage.outputTokens += outputTokens
      modelUsage.cacheReadInputTokens += cacheReadInputTokens
      modelUsage.cacheCreationInputTokens += cacheCreationInputTokens
      modelUsage.webSearchRequests += webSearchRequests
      modelUsage.costUSD += costUSD
      modelUsage.costDisplay = this.formatCost(modelUsage.costUSD)

      totalCostUSD += costUSD
      totalInputTokens += inputTokens
      totalOutputTokens += outputTokens
      totalCacheReadInputTokens += cacheReadInputTokens
      totalCacheCreationInputTokens += cacheCreationInputTokens
      totalWebSearchRequests += webSearchRequests

      if (entry.timestamp) {
        const time = Date.parse(entry.timestamp)
        if (!Number.isNaN(time)) {
          firstUsageAt = firstUsageAt === null ? time : Math.min(firstUsageAt, time)
          lastUsageAt = lastUsageAt === null ? time : Math.max(lastUsageAt, time)
        }
      }
    })

    const workDir = latestWorkDir || latestCwd || this.desanitizePath(found.projectDir) || process.cwd()
    const launchInfo: SessionLaunchInfo = {
      filePath: found.filePath,
      projectDir: found.projectDir,
      workDir,
      repository,
      worktreeSession,
      transcriptMessageCount,
      customTitle,
      permissionMode,
      ...(runtimeProviderId !== undefined ? { runtimeProviderId } : {}),
      ...(runtimeModelId ? { runtimeModelId } : {}),
      ...(effortLevel ? { effortLevel } : {}),
    }

    for (const modelUsage of models.values()) {
      modelUsage.contextWindow = await this.getTranscriptContextWindow(
        sessionId,
        modelUsage.model,
        launchInfo,
      )
    }

    const usage = models.size === 0
      ? null
      : {
          source: 'transcript' as const,
          totalCostUSD,
          costDisplay: this.formatCost(totalCostUSD),
          hasUnknownModelCost,
          totalAPIDuration: 0,
          totalDuration:
            firstUsageAt !== null && lastUsageAt !== null
              ? Math.max(0, Math.round((lastUsageAt - firstUsageAt) / 1000))
              : 0,
          totalLinesAdded: 0,
          totalLinesRemoved: 0,
          totalInputTokens,
          totalOutputTokens,
          totalCacheReadInputTokens,
          totalCacheCreationInputTokens,
          totalWebSearchRequests,
          models: Array.from(models.values()),
        }
    const contextEstimate = latestContextUsage
      ? await this.buildTranscriptContextEstimate(
          sessionId,
          latestContextUsage,
          estimatedTokensFromMessages,
          transcriptHasMediaInput,
          launchInfo,
        )
      : null

    return {
      launchInfo,
      metadata,
      usage,
      contextEstimate,
    }
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * List all sessions, optionally filtered by project path.
   */
  async listSessions(options?: {
    project?: string
    limit?: number
    offset?: number
  }): Promise<{ sessions: SessionListItem[]; total: number }> {
    this.syncSharedMutationEpoch()
    const routingMutationEpoch = getSharedSessionMutationState(this.localIndexGateway).epoch
    const hasInvalidPagination = [options?.limit, options?.offset]
      .some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))
    if (hasInvalidPagination) return this.listSessionsFromFiles(options)

    const indexMode = this.getUsableIndexMode()
    if (indexMode === null) {
      return this.listSessionsFromFiles(options)
    }

    if (indexMode === 'shadow') {
      const fileResult = await this.listSessionsFromFiles(options)
      if (
        routingMutationEpoch !== getSharedSessionMutationState(this.localIndexGateway).epoch
      ) {
        return this.listSessionsFromFiles(options)
      }
      let status: LocalIndexStatus
      try {
        status = this.localIndexGateway.getPublicStatus()
      } catch {
        this.markIndexReadFailure()
        return fileResult
      }
      if (status.state !== 'ready') return fileResult
      const indexedResult = await this.tryListSessionsFromIndex(options, true)
      if (
        routingMutationEpoch !== getSharedSessionMutationState(this.localIndexGateway).epoch
      ) {
        return this.listSessionsFromFiles(options)
      }
      if (indexedResult) {
        this.recordShadowComparisonIfNeeded(
          this.compareSessionLists(fileResult, indexedResult),
        )
      }
      return fileResult
    }

    return await this.tryListSessionsFromIndex(options) ?? this.listSessionsFromFiles(options)
  }

  private async listSessionsFromFiles(options?: {
    project?: string
    limit?: number
    offset?: number
  }): Promise<{ sessions: SessionListItem[]; total: number }> {
    this.syncSharedMutationEpoch()
    const scope = this.getConfigDir()
    this.prepareSessionListCaches(scope)
    const cacheKey = this.sessionListCacheKey(options, scope)
    const cached = this.sessionListCache.get(cacheKey)
    if (cached) {
      this.touchSessionListCacheEntry(cacheKey, cached)
      return this.cloneSessionListResult(cached.result)
    }

    const cacheGeneration = this.sessionListCacheGeneration
    const sharedMutationEpoch = getSharedSessionMutationState(this.localIndexGateway).epoch
    const requestKey = `${cacheGeneration}:${sharedMutationEpoch}:${cacheKey}`
    const inFlight = this.sessionListRequests.get(requestKey)
    if (inFlight) {
      return this.cloneSessionListResult(await inFlight)
    }

    const request = this.loadSessionList(
      options,
      cacheKey,
      cacheGeneration,
      sharedMutationEpoch,
      scope,
    )
    this.sessionListRequests.set(requestKey, request)
    try {
      return this.cloneSessionListResult(await request)
    } finally {
      if (this.sessionListRequests.get(requestKey) === request) {
        this.sessionListRequests.delete(requestKey)
      }
    }
  }

  private async tryListSessionsFromIndex(options?: {
    project?: string
    limit?: number
    offset?: number
  }, requireReady = false): Promise<{ sessions: SessionListItem[]; total: number } | null> {
    const indexedMutationEpoch = getSharedSessionMutationState(this.localIndexGateway).epoch
    try {
      const indexedPage = this.localIndexGateway.listSessions({
        ...(options?.project
          ? {
              project: this.sanitizePath(
                normalizeDriveRootPathForPlatform(options.project),
              ),
            }
          : {}),
        ...(options?.limit !== undefined ? { limit: options.limit } : {}),
        ...(options?.offset !== undefined ? { offset: options.offset } : {}),
      })
      if (!this.indexStatusRemainsUsable()) {
        this.markIndexReadFailure()
        return null
      }

      const status = this.localIndexGateway.getPublicStatus()
      if (requireReady && status.state !== 'ready') return null
      if (status.state === 'building' && indexedPage.sessions.length === 0) {
        return null
      }

      const sessions: SessionListItem[] = []
      const pathExists = this.createCachedPathExists()
      const projectsRoot = indexedPage.sessions.length > 0
        ? await fs.realpath(this.getProjectsDir())
        : null
      for (const row of indexedPage.sessions) {
        await this.validateIndexedTranscriptPath(
          row.transcriptPath,
          row.projectPath,
          row.id,
          projectsRoot!,
        )
        sessions.push(await this.hydrateIndexedSession(row, pathExists))
      }
      if (sessions.length !== indexedPage.sessions.length) return null
      if (
        indexedMutationEpoch !== getSharedSessionMutationState(this.localIndexGateway).epoch
      ) {
        return null
      }
      return { sessions, total: indexedPage.total }
    } catch {
      this.markIndexReadFailure()
      return null
    }
  }

  private async hydrateIndexedSession(
    row: IndexedSessionRow,
    pathExists = (targetPath: string | null) => this.pathExists(targetPath),
  ): Promise<SessionListItem> {
    const workDir = row.workDir
    const projectRoot = await this.resolveProjectRootFromSessionMetadata({
      worktreeSession: row.worktreeSession,
      repository: row.repository,
      workDir,
      fallbackProjectDir: row.projectPath,
    })
    const { workDirExists, workspaceState } = await this.resolveWorkspaceAvailability({
      workDir,
      projectRoot,
      worktreeSession: row.worktreeSession,
      repository: row.repository,
      pathExists,
    })
    return {
      id: row.id,
      title: row.title,
      createdAt: row.createdAt,
      modifiedAt: row.modifiedAt,
      messageCount: row.messageCount,
      projectPath: row.projectPath,
      projectRoot,
      workDir,
      workDirExists,
      workspaceState,
      permissionMode: row.permissionMode,
      ...(row.runtimeProviderId !== undefined
        ? { runtimeProviderId: row.runtimeProviderId }
        : {}),
      ...(row.runtimeModelId ? { runtimeModelId: row.runtimeModelId } : {}),
      ...(row.effortLevel ? { effortLevel: row.effortLevel } : {}),
    }
  }

  private compareSessionLists(
    fileResult: { sessions: SessionListItem[]; total: number },
    indexedResult: { sessions: SessionListItem[]; total: number },
  ): SessionListShadowComparison {
    const fieldHashes: SessionListShadowComparison['fieldHashes'] = []
    const fields: Array<keyof SessionListItem> = [
      'id',
      'title',
      'createdAt',
      'modifiedAt',
      'messageCount',
      'projectPath',
      'projectRoot',
      'workDir',
      'workDirExists',
      'workspaceState',
      'permissionMode',
      'runtimeProviderId',
      'runtimeModelId',
      'effortLevel',
    ]
    const hash = (value: unknown): string => createHash('sha256')
      .update(JSON.stringify(value) ?? 'undefined')
      .digest('hex')
    const rowCount = Math.max(fileResult.sessions.length, indexedResult.sessions.length)
    let differenceCount = fileResult.total === indexedResult.total ? 0 : 1
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      for (const field of fields) {
        const fileSession = fileResult.sessions[rowIndex]
        const indexedSession = indexedResult.sessions[rowIndex]
        const fileField = {
          present: fileSession !== undefined && Object.hasOwn(fileSession, field),
          value: fileSession?.[field],
        }
        const indexedField = {
          present: indexedSession !== undefined && Object.hasOwn(indexedSession, field),
          value: indexedSession?.[field],
        }
        if (JSON.stringify(fileField) === JSON.stringify(indexedField)) continue
        differenceCount += 1
        if (fieldHashes.length < 16) {
          fieldHashes.push({
            field: `session_${rowIndex}.${field}`,
            fileHash: hash(fileField),
            indexedHash: hash(indexedField),
          })
        }
      }
    }
    return {
      matched: differenceCount === 0,
      fileTotal: fileResult.total,
      indexedTotal: indexedResult.total,
      fileCount: fileResult.sessions.length,
      indexedCount: indexedResult.sessions.length,
      differenceCount,
      fieldHashes,
    }
  }

  private recordShadowComparisonIfNeeded(comparison: SessionListShadowComparison): void {
    const signature = createHash('sha256')
      .update(JSON.stringify(comparison))
      .digest('hex')
    if (signature === this.lastShadowComparisonSignature) return
    const now = this.now()
    if (now - this.lastShadowComparisonRecordedAt < this.shadowComparisonMinIntervalMs) return
    this.lastShadowComparisonSignature = signature
    this.lastShadowComparisonRecordedAt = now
    this.recordShadowComparison(comparison)
  }

  private async loadSessionList(
    options: {
      project?: string
      limit?: number
      offset?: number
    } | undefined,
    cacheKey: string,
    cacheGeneration: number,
    sharedMutationEpoch: number,
    scope: string,
  ): Promise<{ sessions: SessionListItem[]; total: number }> {
    const sessionFiles = await this.discoverSessionFiles(options?.project, scope)
    if (!options?.project && this.activeSessionListCacheScope === scope) {
      const discoveredPaths = new Set(sessionFiles.map(file => file.filePath))
      for (const filePath of this.sessionListSummaryCache.keys()) {
        if (!discoveredPaths.has(filePath)) this.sessionListSummaryCache.delete(filePath)
      }
      // C11：持久索引同步剔除已消失的会话文件（仅全量发现时；按 project 过滤的
      // 发现结果不完整，剔除会误伤其它项目的条目）
      void sessionSummaryIndexStore
        .ensureLoaded()
        .then(() => sessionSummaryIndexStore.pruneMissing(discoveredPaths))
        .catch(() => {})
    }
    const filesWithStats = (await Promise.all(sessionFiles.map(async (sessionFile) => {
      try {
        return {
          ...sessionFile,
          stat: await fs.stat(sessionFile.filePath),
        }
      } catch {
        return null
      }
    }))).filter((item): item is NonNullable<typeof item> => item !== null)

    // v1.5.0 C11：排序/分页前置于「全量摘要」。
    //
    // 旧实现在切片之前**摘要全部会话文件**（每个未缓存文件都要流式扫全文），
    // 单项目 127MB 目录 / 数百会话时列表接口被拖成秒级——绝大多数摘要做出来
    // 随即被 slice 丢掉。
    //
    // 排序键不能用 stat.mtime：列表的 modifiedAt 语义来自**内容**
    // （transcriptReducer 的 semanticModifiedAt = 最后一条 user/assistant 的
    // timestamp），metadata-only 写入（仅 touch 文件）会改 mtime 却不该改变
    // 排序——有专门的回归测试锁定这一点。这里改用**尾部窗口读**取内容时间戳：
    // 只读文件末尾 64KB（并有持久缓存，mtime+size 未变零成本），拿到与全量
    // 摘要一致的排序键，成本从"全量扫描 157MB"降到"每文件 ≤64KB 且大多命中缓存"。
    const sortKeys = await this.mapWithConcurrency(filesWithStats, 16, async (item) => ({
      ...item,
      tailModifiedAt: await this.readTailModifiedAt(
        item.filePath,
        item.stat,
        item.projectDir,
        scope,
      ),
    }))
    sortKeys.sort((a, b) => {
      const modifiedDifference =
        Date.parse(b.tailModifiedAt) - Date.parse(a.tailModifiedAt)
      if (modifiedDifference !== 0) return modifiedDifference
      const sessionIdDifference = a.sessionId.localeCompare(b.sessionId)
      return sessionIdDifference || a.filePath.localeCompare(b.filePath)
    })

    const total = sortKeys.length
    const offset = options?.offset ?? 0
    const limit = options?.limit ?? 50
    const paginatedFiles: Array<{
      filePath: string
      projectDir: string
      sessionId: string
      stat: Stats
      summary: SessionListSummary
    }> = []
    for (const item of sortKeys.slice(offset, offset + limit)) {
      try {
        paginatedFiles.push({
          ...item,
          summary: await this.getCachedSessionListSummary(
            item.filePath,
            item.projectDir,
            item.stat,
            scope,
          ),
        })
      } catch {
        // Skip unreadable files
      }
    }

    // Build session list items with metadata from file stats & a streaming
    // transcript summary. Keep this sequential so large JSONL files are not
    // loaded into memory concurrently by the sidebar's frequent refresh.
    const items: SessionListItem[] = []
    const pathExists = this.createCachedPathExists()
    for (const { projectDir, sessionId, summary } of paginatedFiles) {
      try {
        const workDir = summary.workDir
        const projectRoot = await this.resolveProjectRootFromSessionMetadata({
          worktreeSession: summary.worktreeSession,
          repository: summary.repository,
          workDir,
          fallbackProjectDir: projectDir,
        })
        const { workDirExists, workspaceState } = await this.resolveWorkspaceAvailability({
          workDir,
          projectRoot,
          worktreeSession: summary.worktreeSession,
          repository: summary.repository,
          pathExists,
        })

        items.push({
          id: sessionId,
          title: summary.title,
          createdAt: summary.createdAt,
          modifiedAt: summary.modifiedAt,
          messageCount: summary.messageCount,
          projectPath: projectDir,
          projectRoot,
          workDir,
          workDirExists,
          workspaceState,
          permissionMode: summary.permissionMode,
          ...(summary.runtimeProviderId !== undefined
            ? { runtimeProviderId: summary.runtimeProviderId }
            : {}),
          ...(summary.runtimeModelId ? { runtimeModelId: summary.runtimeModelId } : {}),
          ...(summary.effortLevel ? { effortLevel: summary.effortLevel } : {}),
        })
      } catch {
        // Skip unreadable files
      }
    }

    const result = { sessions: items, total }
    if (
      cacheGeneration === this.sessionListCacheGeneration &&
      sharedMutationEpoch === getSharedSessionMutationState(this.localIndexGateway).epoch &&
      this.activeSessionListCacheScope === scope
    ) {
      this.sessionListCache.set(cacheKey, {
        expiresAt: this.now() + this.sessionListCacheTtlMs,
        result: this.cloneSessionListResult(result),
      })
      this.enforceSessionListCacheCapacity()
    }
    return result
  }

  /**
   * Get full session detail including all messages.
   */
  async getSession(sessionId: string): Promise<SessionDetail | null> {
    const found = await this.findSessionFile(sessionId)
    if (!found) return null

    const { filePath, projectDir } = found
    const stat = await fs.stat(filePath)
    const entries = await this.readJsonlFile(filePath)

    const messages = await this.appendSubagentToolMessages(
      projectDir,
      sessionId,
      this.entriesToMessages(entries),
    )
    const title = this.extractTitle(entries)
    const workDir = this.resolveWorkDirFromEntries(entries, projectDir)
    const permissionMode = this.resolvePermissionModeFromEntries(entries)
    const projectRoot = await this.resolveProjectRootFromEntries(entries, workDir, projectDir)
    const worktreeSession = this.resolveWorktreeSessionFromEntries(entries)
    const repository = this.resolveRepositoryFromEntries(entries)
    const { workDirExists, workspaceState } = await this.resolveWorkspaceAvailability({
      workDir,
      projectRoot,
      worktreeSession,
      repository,
    })

    let createdAt = stat.birthtime.toISOString()
    for (const e of entries) {
      if (e.timestamp) {
        createdAt = e.timestamp
        break
      }
    }

    return {
      id: sessionId,
      title,
      createdAt,
      modifiedAt: this.resolveTranscriptModifiedAtFromEntries(entries) ?? stat.mtime.toISOString(),
      messageCount: messages.length,
      projectPath: projectDir,
      projectRoot,
      workDir,
      workDirExists,
      workspaceState,
      permissionMode,
      messages,
    }
  }

  /**
   * Get only the messages for a session (lighter than full detail).
   */
  async getSessionMessages(sessionId: string): Promise<MessageEntry[]> {
    const found = await this.findSessionFile(sessionId)
    if (!found) {
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }

    const entries = await this.readJsonlFile(found.filePath)
    return await this.appendSubagentToolMessages(
      found.projectDir,
      sessionId,
      this.entriesToMessages(entries),
    )
  }

  /**
   * 窗口化会话历史（v1.5.0 · 大会话首开）：只解析窗口内的条目。
   *
   * 旧路径（getSessionMessages）把整份 jsonl 读进内存再逐行 JSON.parse——127MB
   * 会长会话首开时内存与 CPU 双高。本方法流式扫文件，**只对窗口内的原始行做
   * parse**，其余行仅计数（total）；峰值内存 ≈ 窗口行文本。
   *
   * 游标：`before` 是**条目序号**（0-based，非空行计）——jsonl 只追加，历史条目
   * 的序号天然稳定，前端向上翻页不会错位。返回窗口 [max(0,before-limit), before)，
   * 响应带 nextBefore（= 窗口起始序号）供继续向上翻页。
   *
   * total 是**非空行数**（含极少数坏行）——与全量模式的"parse 成功条数"可能有
   * 微小差异，仅用于"还有多少/是否还有更早"的展示，不参与定位。
   *
   * 子代理消息注入与全量模式同款（只依据窗口内出现的 agent 链接），行为自洽。
   */
  async getSessionMessagesWindow(
    sessionId: string,
    options: { limit: number; before?: number },
  ): Promise<{
    messages: MessageEntry[]
    total: number
    hasMore: boolean
    nextBefore: number
    /**
     * 会话级 token 用量合计（v1.5.0 窗口模式配套）：窗口只映射一页历史，
     * 前端据此累加的用量会偏小，所以由服务端按**全文件**口径给出。
     * null = 全文件里一条带 usage 的消息都没有。
     * 口径与前端 chatStore.summarizeTokenUsageFromHistory 逐项一致。
     */
    usageTotals: SessionUsageTotals | null
  }> {
    const found = await this.findSessionFile(sessionId)
    if (!found) {
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }
    const limit = Math.max(1, Math.floor(options.limit))
    const beforeRaw = options.before
    const before =
      beforeRaw !== undefined && Number.isFinite(beforeRaw)
        ? Math.max(0, Math.floor(beforeRaw))
        : undefined

    // 用量合计随 mtime+size 缓存：文件没变就直接用上次结果，不重扫（低2 同款：
    // 命中只更新内存 LRU 序）。未缓存（undefined）才要求本次扫描顺带累加。
    const stat = await fs.stat(found.filePath)
    await sessionSummaryIndexStore.ensureLoaded()
    const cachedUsage = sessionSummaryIndexStore.getUsageTotals(
      found.filePath,
      stat.mtimeMs,
      stat.size,
    )

    const window = await this.readJsonlFileWindow(found.filePath, {
      limit,
      ...(before !== undefined ? { before } : {}),
      ...(cachedUsage === undefined ? { collectUsage: true } : {}),
    })
    const usageTotals = cachedUsage === undefined ? (window.usageTotals ?? null) : cachedUsage
    if (cachedUsage === undefined) {
      sessionSummaryIndexStore.setUsageTotals(
        found.filePath,
        stat.mtimeMs,
        stat.size,
        usageTotals,
      )
    }

    const messages = await this.appendSubagentToolMessages(
      found.projectDir,
      sessionId,
      this.entriesToMessages(window.entries),
    )
    return {
      messages,
      total: window.total,
      hasMore: window.startIndex > 0,
      nextBefore: window.startIndex,
      usageTotals,
    }
  }

  /**
   * 流式读取 jsonl 的窗口：单遍扫描，只保留窗口内原始行的文本（不 parse 其余行）。
   * 窗口：无 before → 最后 limit 条；有 before → [before-limit, before)。
   *
   * 多收 OVERSCAN 行再 parse 后截尾：坏行（parse 失败）也会占一个行序号，若严格
   * 只收 limit 行，窗口内可用条目会少于 limit（实测 fixture 下一个坏行就少 1 条）。
   * 多收几行把坏行"吸收"掉，返回的首条序号即游标（可能 > 窗口起点，但保证
   * 不丢不重——下一次 before 用它继续向上翻）。
   *
   * collectUsage（v1.5.0）：同一遍扫描顺带累加全文件的 token 用量合计，
   * **不额外扫第二遍**（见 accumulateUsageFromLine 的廉价过滤）。
   */
  private async readJsonlFileWindow(
    filePath: string,
    options: { limit: number; before?: number; collectUsage?: boolean },
  ): Promise<{
    entries: RawEntry[]
    total: number
    startIndex: number
    usageTotals?: SessionUsageTotals | null
  }> {
    const OVERSCAN_LINES = 8
    const stream = createReadStream(filePath, { encoding: 'utf8' })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    const before = options.before
    const collectLimit = options.limit + OVERSCAN_LINES
    const buffered: Array<{ index: number; text: string }> = []
    const usageAcc: UsageAccumulator = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    }
    let total = 0
    try {
      for await (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        if (options.collectUsage) this.accumulateUsageFromLine(trimmed, usageAcc)
        const index = total
        total += 1
        if (before === undefined) {
          buffered.push({ index, text: trimmed })
          if (buffered.length > collectLimit) buffered.shift()
          continue
        }
        const lowerBound = before - collectLimit
        if (index >= lowerBound && index < before) {
          buffered.push({ index, text: trimmed })
        }
        // 越过窗口上界仍继续计数（total 要准；只数行、不 parse，成本很低）
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    } finally {
      lines.close()
      stream.destroy()
    }

    const parsed: Array<{ index: number; entry: RawEntry }> = []
    for (const { index, text } of buffered) {
      try {
        parsed.push({ index, entry: JSON.parse(text) as RawEntry })
      } catch {
        // skip malformed lines（与全量路径同款容错）
      }
    }
    const windowed = parsed.slice(-options.limit)
    const startIndex = windowed.length > 0 ? windowed[0]!.index : total
    return {
      entries: windowed.map((item) => item.entry),
      total,
      startIndex,
      ...(options.collectUsage ? { usageTotals: this.buildUsageTotals(usageAcc) } : {}),
    }
  }

  /**
   * 顺带累加一行的 token 用量（v1.5.0 窗口模式配套）。
   *
   * 廉价过滤：只对**含 usage 字样的行**做 JSON.parse。会话里占体积的是
   * tool_result / 附件类的超长行，它们不带 usage——子串检查一行 O(len) 的
   * 字符串扫描就能挡掉，避免为用量付出一次全量 parse 的代价。
   * 坏行/半行与窗口路径同款容错（跳过）。
   */
  private accumulateUsageFromLine(line: string, acc: UsageAccumulator): void {
    if (!line.includes('"usage"')) return
    let entry: RawEntry
    try {
      entry = JSON.parse(line) as RawEntry
    } catch {
      return
    }
    const usage = normalizeMessageUsage(entry.message?.usage)
    if (!usage) return
    acc.inputTokens += usage.input_tokens ?? 0
    acc.outputTokens += usage.output_tokens ?? 0
    acc.cacheReadTokens += usage.cache_read_input_tokens ?? 0
    acc.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0
  }

  /**
   * 汇总成对外的 usageTotals。**与前端 chatStore.summarizeTokenUsageFromHistory
   * 逐项一致**：四项全 0 → null；cache 两项仅在 > 0 时出现（输出名去掉 input）。
   */
  private buildUsageTotals(acc: UsageAccumulator): SessionUsageTotals | null {
    if (
      acc.inputTokens === 0 &&
      acc.outputTokens === 0 &&
      acc.cacheReadTokens === 0 &&
      acc.cacheCreationTokens === 0
    ) {
      return null
    }
    return {
      input_tokens: acc.inputTokens,
      output_tokens: acc.outputTokens,
      ...(acc.cacheReadTokens > 0 ? { cache_read_tokens: acc.cacheReadTokens } : {}),
      ...(acc.cacheCreationTokens > 0
        ? { cache_creation_tokens: acc.cacheCreationTokens }
        : {}),
    }
  }

  async getSubagentTranscriptMessages(
    sessionId: string,
    agentId: string,
  ): Promise<MessageEntry[]> {
    const found = await this.findSessionFile(sessionId)
    if (!found) {
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }

    const entries = await this.readJsonlFile(
      this.subagentTranscriptPath(found.projectDir, sessionId, agentId),
    )
    return this.entriesToMessages(entries)
  }

  async getSessionMessagesSignature(sessionId: string): Promise<string | null> {
    const found = await this.findSessionFile(sessionId)
    if (!found) return null

    let count = 0
    let last = ''
    const agentToolUseIds = new Set<string>()
    const resultLinks = new Map<string, string>()
    await this.streamJsonlFile(found.filePath, (entry) => {
      const agentToolUseId = this.extractAgentToolUseId(entry)
      if (agentToolUseId) {
        agentToolUseIds.add(agentToolUseId)
      }
      if (entry.message?.role === 'user' && Array.isArray(entry.message.content)) {
        for (const block of entry.message.content as ContentBlock[]) {
          if (
            block.type !== 'tool_result' ||
            typeof block.tool_use_id !== 'string' ||
            !agentToolUseIds.has(block.tool_use_id)
          ) {
            continue
          }
          const agentId = this.extractAgentIdFromResultText(
            this.extractTextFromContent(block.content),
          )
          if (agentId) {
            resultLinks.set(block.tool_use_id, agentId)
          }
        }
      }
      if (!this.isVisibleTranscriptMessageEntry(entry)) return
      count += 1
      const contentLength = safeJsonLength(entry.content) + safeJsonLength(entry.message?.content)
      last = [
        entry.uuid ?? entry.messageId ?? '',
        entry.type ?? '',
        entry.timestamp ?? '',
        entry.parentUuid ?? '',
        entry.parent_tool_use_id ?? '',
        contentLength,
      ].join(':')
    })

    const subagentSignatures = await Promise.all(
      [...resultLinks.entries()].map(async ([parentToolUseId, agentId]) => {
        let childCount = 0
        let childLast = ''
        await this.streamJsonlFile(this.subagentTranscriptPath(found.projectDir, sessionId, agentId), (entry) => {
          if (!this.isVisibleTranscriptMessageEntry(entry)) return
          childCount += 1
          const contentLength = safeJsonLength(entry.content) + safeJsonLength(entry.message?.content)
          childLast = [
            parentToolUseId,
            agentId,
            entry.uuid ?? entry.messageId ?? '',
            entry.type ?? '',
            entry.timestamp ?? '',
            entry.parentUuid ?? '',
            entry.parent_tool_use_id ?? '',
            contentLength,
          ].join(':')
        })
        return `${parentToolUseId}:${agentId}:${childCount}:${childLast}`
      }),
    )

    return `${count}:${last}:${subagentSignatures.join('|')}`
  }

  /**
   * Create a new session file for the given working directory.
   */
  async createSession(
    workDir?: string,
    repositoryOptions?: CreateSessionRepositoryOptions,
    permissionMode?: string,
  ): Promise<{ sessionId: string; workDir: string }> {
    // Default to user home directory when no workDir specified
    const resolvedWorkDir = workDir || os.homedir()
    const sessionId = crypto.randomUUID()

    // Resolve to absolute path. NOTE: path.resolve() uses process.cwd() to
    // expand relative paths — in bundled sidecar mode the server's cwd is
    // typically '/'. Callers already send absolute realPath,
    // but we log here so cwd regressions are caught early.
    const preparedWorkspace = await resolveSessionWorkspaceLaunch(
      resolvedWorkDir,
      repositoryOptions,
      sessionId,
    )
    const absWorkDir = preparedWorkspace.workDir
    registerFilesystemAccessRoot(absWorkDir)
    console.log(
      `[SessionService] createSession: requested workDir=${JSON.stringify(
        workDir,
      )}, resolved=${absWorkDir}, repository=${JSON.stringify(
        preparedWorkspace.repository ?? null,
      )} (process.cwd()=${process.cwd()})`,
    )

    const sanitized = this.sanitizePath(absWorkDir)
    const dirPath = path.join(this.getProjectsDir(), sanitized)

    // Ensure the project directory exists
    await fs.mkdir(dirPath, { recursive: true })

    const filePath = path.join(dirPath, `${sessionId}.jsonl`)
    const now = new Date().toISOString()

    // Write an initial file-history-snapshot entry (matches CLI behavior)
    const initialEntry = {
      type: 'file-history-snapshot',
      messageId: crypto.randomUUID(),
      snapshot: {
        messageId: crypto.randomUUID(),
        trackedFileBackups: {},
        timestamp: now,
      },
      isSnapshotUpdate: false,
    }

    // Store actual workDir for later retrieval
    const metaEntry = {
      type: 'session-meta',
      isMeta: true,
      workDir: absWorkDir,
      repository: preparedWorkspace.repository,
      ...(permissionMode && VALID_SESSION_PERMISSION_MODES.has(permissionMode)
        ? { permissionMode }
        : {}),
      timestamp: now,
    }

    await fs.writeFile(filePath, JSON.stringify(initialEntry) + '\n' + JSON.stringify(metaEntry) + '\n', 'utf-8')
    this.invalidateSessionListCache()

    return { sessionId, workDir: absWorkDir }
  }

  /**
   * Delete a session's JSONL file.
   */
  async deleteSession(sessionId: string): Promise<void> {
    const found = await this.findSessionFile(sessionId)
    if (!found) {
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }

    await fs.unlink(found.filePath)
    this.sessionListSummaryCache.delete(found.filePath)
    this.invalidateSessionListCache()
  }

  async deleteSessions(sessionIds: string[]): Promise<DeleteSessionsResult> {
    const successes: string[] = []
    const failures: DeleteSessionFailure[] = []

    const results = await Promise.all(sessionIds.map(async (sessionId) => {
      try {
        await this.deleteSession(sessionId)
        return { type: 'success' as const, sessionId }
      } catch (error) {
        return {
          type: 'failure' as const,
          sessionId,
          message: error instanceof Error ? error.message : 'Unknown delete failure',
          code: error instanceof ApiError ? error.code : undefined,
        }
      }
    }))

    for (const result of results) {
      if (result.type === 'success') {
        successes.push(result.sessionId)
      } else {
        failures.push({
          sessionId: result.sessionId,
          message: result.message,
          code: result.code,
        })
      }
    }

    return { successes, failures }
  }

  /**
   * Rename a session by appending a custom-title entry to its JSONL file.
   */
  async renameSession(sessionId: string, title: string): Promise<void> {
    if (!title || typeof title !== 'string') {
      throw ApiError.badRequest('title is required')
    }

    const found = await this.findSessionFile(sessionId)
    if (!found) {
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }

    const entry = {
      type: 'custom-title',
      customTitle: title,
      timestamp: new Date().toISOString(),
    }

    await this.appendJsonlEntry(found.filePath, entry)
    this.invalidateSessionListCache()
  }

  /**
   * Append an AI-generated title entry to a session's JSONL file.
   */
  async appendAiTitle(sessionId: string, title: string): Promise<void> {
    const found = await this.findSessionFile(sessionId)
    if (!found) return

    await this.appendJsonlEntry(found.filePath, {
      type: 'ai-title',
      aiTitle: title,
      timestamp: new Date().toISOString(),
    })
    this.invalidateSessionListCache()
  }

  async getCustomTitle(sessionId: string): Promise<string | null> {
    const found = await this.findSessionFile(sessionId)
    if (!found) return null

    const entries = await this.readJsonlFile(found.filePath)
    let customTitle: string | null = null
    for (const entry of entries) {
      if (entry.type === 'custom-title' && typeof entry.customTitle === 'string' && entry.customTitle.trim()) {
        customTitle = entry.customTitle
      }
    }
    return customTitle
  }

  /**
   * Get the actual working directory for a session.
   * First checks for stored session-meta entry, then falls back to desanitizePath.
   */
  async getSessionWorkDir(sessionId: string): Promise<string | null> {
    const found = await this.findSessionFile(sessionId)
    if (!found) return null

    const entries = await readTranscriptCached(found.filePath)
    return this.resolveWorkDirFromEntries(entries, found.projectDir)
  }

  async getSessionMessageCwd(
    sessionId: string,
    messageId: string,
  ): Promise<string | null> {
    const found = await this.findSessionFile(sessionId)
    if (!found) return null

    const entries = await readTranscriptCached(found.filePath)
    const entry = entries.find((candidate) => candidate.uuid === messageId)
    return typeof entry?.cwd === 'string' && entry.cwd.trim() ? entry.cwd : null
  }

  /**
   * Inspect how a session should be launched.
   * Placeholder desktop-created sessions have zero transcript messages.
   */
  async getSessionLaunchInfo(sessionId: string): Promise<SessionLaunchInfo | null> {
    const found = await this.findSessionFile(sessionId)
    if (!found) return null

    const entries = await readTranscriptCached(found.filePath)
    const workDir = this.resolveWorkDirFromEntries(entries, found.projectDir) || process.cwd()
    const repository = this.resolveRepositoryFromEntries(entries)
    const worktreeSession = this.resolveWorktreeSessionFromEntries(entries)
    const permissionMode = this.resolvePermissionModeFromEntries(entries)
    let customTitle: string | null = null
    let runtimeProviderId: string | null | undefined
    let runtimeModelId: string | undefined
    let effortLevel: string | undefined

    for (const entry of entries) {
      if (entry.type === 'custom-title' && typeof entry.customTitle === 'string') {
        customTitle = entry.customTitle
      }
      if (entry.type === 'session-meta') {
        const record = entry as Record<string, unknown>
        if (record.runtimeProviderId === null || typeof record.runtimeProviderId === 'string') {
          runtimeProviderId = record.runtimeProviderId as string | null
        }
        if (typeof record.runtimeModelId === 'string') {
          runtimeModelId = record.runtimeModelId
        }
        if (
          typeof record.effortLevel === 'string' &&
          VALID_SESSION_EFFORT_LEVELS.has(record.effortLevel)
        ) {
          effortLevel = record.effortLevel
        }
      }
    }
    const transcriptMessageCount = this.countTranscriptMessages(entries)

    return {
      filePath: found.filePath,
      projectDir: found.projectDir,
      workDir,
      repository,
      worktreeSession,
      transcriptMessageCount,
      customTitle,
      permissionMode,
      ...(runtimeProviderId !== undefined ? { runtimeProviderId } : {}),
      ...(runtimeModelId ? { runtimeModelId } : {}),
      ...(effortLevel ? { effortLevel } : {}),
    }
  }

  async deleteSessionFile(sessionId: string): Promise<void> {
    const found = await this.findSessionFile(sessionId)
    if (!found) return
    await fs.unlink(found.filePath)
    this.invalidateSessionListCache()
  }

  async clearSessionTranscript(
    sessionId: string,
    fallbackWorkDir?: string,
    preservedPermissionMode?: string,
  ): Promise<void> {
    let found = await this.findSessionFile(sessionId)
    if (!found && fallbackWorkDir) {
      const resolvedPath = path.resolve(normalizeDriveRootPathForPlatform(fallbackWorkDir))
      const absWorkDir = await fs.realpath(resolvedPath).catch(() => resolvedPath)
      const dirPath = path.join(this.getProjectsDir(), this.sanitizePath(absWorkDir))
      await fs.mkdir(dirPath, { recursive: true })
      found = {
        filePath: path.join(dirPath, `${sessionId}.jsonl`),
        projectDir: this.sanitizePath(absWorkDir),
      }
    }
    if (!found) {
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }

    const entries = await this.readJsonlFile(found.filePath)
    const workDir = this.resolveWorkDirFromEntries(entries, found.projectDir) || fallbackWorkDir || process.cwd()
    const repository = this.resolveRepositoryFromEntries(entries)
    const permissionMode = (
      preservedPermissionMode &&
      VALID_SESSION_PERMISSION_MODES.has(preservedPermissionMode)
    )
      ? preservedPermissionMode
      : this.resolvePermissionModeFromEntries(entries)
    const now = new Date().toISOString()

    const initialEntry = {
      type: 'file-history-snapshot',
      messageId: crypto.randomUUID(),
      snapshot: {
        messageId: crypto.randomUUID(),
        trackedFileBackups: {},
        timestamp: now,
      },
      isSnapshotUpdate: false,
    }

    const metaEntry = {
      type: 'session-meta',
      isMeta: true,
      workDir,
      repository,
      ...(permissionMode ? { permissionMode } : {}),
      timestamp: now,
    }

    await fs.writeFile(
      found.filePath,
      `${JSON.stringify(initialEntry)}\n${JSON.stringify(metaEntry)}\n`,
      'utf-8',
    )
    this.invalidateSessionListCache()
  }

  async appendSessionMetadata(
    sessionId: string,
    metadata: {
      workDir: string
      customTitle?: string | null
      repository?: PreparedSessionWorkspace['repository']
      permissionMode?: string
      runtimeProviderId?: string | null
      runtimeModelId?: string
      effortLevel?: string
    }
  ): Promise<void> {
    const matches = await this.findSessionFiles(sessionId)
    if (matches.length === 0) return

    let repository = metadata.repository
    if (!repository) {
      for (const match of matches) {
        const candidate = this.resolveRepositoryFromEntries(await this.readJsonlFile(match.filePath))
        if (candidate) {
          repository = candidate
          break
        }
      }
    }

    const normalizedWorkDir = normalizeDriveRootPathForPlatform(metadata.workDir)
    const targetProjectDir = this.sanitizePath(normalizedWorkDir)
    const targetFilePath = path.join(this.getProjectsDir(), targetProjectDir, `${sessionId}.jsonl`)

    if (!metadata.customTitle) {
      const launchInfo = await this.getSessionLaunchInfo(sessionId)
      if (this.metadataMatchesLaunchInfo(launchInfo, {
        ...metadata,
        workDir: normalizedWorkDir,
        repository,
      })) {
        return
      }
    }

    await fs.mkdir(path.dirname(targetFilePath), { recursive: true })

    await this.appendJsonlEntry(targetFilePath, {
      type: 'session-meta',
      isMeta: true,
      workDir: normalizedWorkDir,
      repository,
      ...(metadata.permissionMode && VALID_SESSION_PERMISSION_MODES.has(metadata.permissionMode)
        ? { permissionMode: metadata.permissionMode }
        : {}),
      ...(metadata.runtimeProviderId !== undefined
        ? { runtimeProviderId: metadata.runtimeProviderId }
        : {}),
      ...(metadata.runtimeModelId ? { runtimeModelId: metadata.runtimeModelId } : {}),
      ...(metadata.effortLevel && VALID_SESSION_EFFORT_LEVELS.has(metadata.effortLevel)
        ? { effortLevel: metadata.effortLevel }
        : {}),
      timestamp: new Date().toISOString(),
    })

    if (metadata.customTitle) {
      await this.appendJsonlEntry(targetFilePath, {
        type: 'custom-title',
        customTitle: metadata.customTitle,
        timestamp: new Date().toISOString(),
      })
    }
    this.invalidateSessionListCache()
  }

  async deletePlaceholderSessionFiles(
    sessionId: string,
    keepWorkDir: string,
  ): Promise<number> {
    if (!this.isValidSessionId(sessionId)) return 0

    const projectsDir = this.getProjectsDir()
    let projectDirs: import('node:fs').Dirent[]
    try {
      projectDirs = await fs.readdir(projectsDir, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw err
    }

    const keepProjectDir = this.sanitizePath(normalizeDriveRootPathForPlatform(keepWorkDir))
    let removed = 0
    for (const projectDir of projectDirs) {
      if (!projectDir.isDirectory()) continue
      if (projectDir.name === keepProjectDir) continue
      const filePath = path.join(projectsDir, projectDir.name, `${sessionId}.jsonl`)
      const entries = await this.readJsonlFile(filePath)
      if (entries.length === 0) continue

      if (this.countTranscriptMessages(entries) > 0) continue

      await fs.rm(filePath, { force: true })
      removed += 1
    }
    if (removed > 0) this.invalidateSessionListCache()
    return removed
  }

  async trimSessionMessagesFrom(
    sessionId: string,
    startMessageId: string,
  ): Promise<TrimSessionResult> {
    const found = await this.findSessionFile(sessionId)
    if (!found) {
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }

    const entries = await this.readJsonlFile(found.filePath)
    const activeMessages = this.entriesToMessages(entries)
    const startIndex = activeMessages.findIndex((message) => message.id === startMessageId)

    if (startIndex < 0) {
      throw ApiError.badRequest(`Message not found in active session chain: ${startMessageId}`)
    }

    const removedMessageIds = activeMessages
      .slice(startIndex)
      .map((message) => message.id)
    const remainingMessageIds = new Set(
      activeMessages
        .slice(0, startIndex)
        .map((message) => message.id),
    )

    if (removedMessageIds.length === 0) {
      return { removedCount: 0, removedMessageIds: [] }
    }

    const removedIds = new Set(removedMessageIds)
    const filteredEntries = entries.filter(
      (entry) => {
        if (typeof entry.uuid !== 'string') return true
        if (removedIds.has(entry.uuid)) return false
        if (
          entry.message?.role &&
          (entry.type === 'user' || entry.type === 'assistant' || entry.type === 'system')
        ) {
          return remainingMessageIds.has(entry.uuid)
        }
        return true
      },
    )

    const content =
      filteredEntries.length > 0
        ? filteredEntries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
        : ''
    await fs.writeFile(found.filePath, content, 'utf-8')
    this.invalidateSessionListCache()

    return {
      removedCount: removedMessageIds.length,
      removedMessageIds,
    }
  }

  async getSessionFileHistorySnapshots(
    sessionId: string,
  ): Promise<FileHistorySnapshot[]> {
    const found = await this.findSessionFile(sessionId)
    if (!found) {
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }

    const entries = await this.readTargetedJsonlEntries(
      found,
      ['file-history-snapshot'],
    ) ?? await this.readJsonlFile(found.filePath)
    const snapshotsByMessageId = new Map<string, FileHistorySnapshot>()

    for (const entry of entries) {
      if (entry.type !== 'file-history-snapshot' || !entry.snapshot) continue

      const snapshotMessageId =
        typeof entry.snapshot.messageId === 'string'
          ? entry.snapshot.messageId
          : typeof entry.messageId === 'string'
            ? entry.messageId
            : null

      if (!snapshotMessageId) continue

      snapshotsByMessageId.set(snapshotMessageId, {
        messageId: snapshotMessageId as FileHistorySnapshot['messageId'],
        trackedFileBackups:
          entry.snapshot.trackedFileBackups &&
          typeof entry.snapshot.trackedFileBackups === 'object'
            ? (entry.snapshot.trackedFileBackups as FileHistorySnapshot['trackedFileBackups'])
            : {},
        timestamp: new Date(
          entry.snapshot.timestamp || entry.timestamp || new Date().toISOString(),
        ),
      })
    }

    return [...snapshotsByMessageId.values()]
  }

  async appendSessionTaskNotification(
    sessionId: string,
    notification: SessionTaskNotification,
  ): Promise<void> {
    const normalized = this.parsePersistedTaskNotification(
      notification,
      notification.timestamp ?? new Date(this.now()).toISOString(),
    )
    if (!normalized) return

    const found = await this.findSessionFile(sessionId)
    if (!found) return

    await this.appendJsonlEntry(found.filePath, {
      type: PERSISTED_TASK_NOTIFICATION_ENTRY_TYPE,
      isMeta: true,
      taskNotification: normalized,
      timestamp: normalized.timestamp,
    })
    this.invalidateSessionListCache()
  }

  async getSessionTaskNotifications(
    sessionId: string,
  ): Promise<SessionTaskNotification[]> {
    const found = await this.findSessionFile(sessionId)
    if (!found) {
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }

    const entries = await this.readTargetedJsonlEntries(
      found,
      ['user', PERSISTED_TASK_NOTIFICATION_ENTRY_TYPE],
    ) ?? await this.readJsonlFile(found.filePath)
    const notifications = new Map<string, SessionTaskNotification>()
    for (const entry of entries) {
      const notification = entry.type === PERSISTED_TASK_NOTIFICATION_ENTRY_TYPE
        ? this.parsePersistedTaskNotification(entry.taskNotification, entry.timestamp)
        : entry.message?.role === 'user'
          ? this.parseTaskNotificationContent(entry.message.content, entry.timestamp)
          : null
      if (notification) notifications.set(notification.toolUseId, notification)
    }
    return [...notifications.values()]
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  // 第⑤批：entriesToMessages 已搬到 ./session/messageConversion.ts（同批，委托块见上）。
  private entriesToMessages = entriesToMessages

  // ── v1.7 结构拆分（sessionService 第⑦批）：workspace 工具组已搬到
  // ./session/workspaceAvailability.ts（同批）。pathExists / createCachedPathExists /
  // resolveWorkspaceAvailability 有组外调用点，改为同名类字段委托；
  // matchesPersistedWorktree / sameWorkspacePath / normalizeWorkspacePath 的唯一调用点
  // 全在搬走的函数体内（组外 0），**不留死委托**，直接删除。
  private pathExists = pathExists

  private createCachedPathExists = createCachedPathExists

  private resolveWorkspaceAvailability = resolveWorkspaceAvailability
}

// Singleton instance for shared use across API handlers
export const sessionService = new SessionService()
