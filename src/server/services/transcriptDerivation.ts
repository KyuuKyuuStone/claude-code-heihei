/**
 * 转录派生域（v1.7.4 结构专项 · B2 族①：上下文窗口/用量族）
 *
 * 从 `sessionService.ts` 整簇外移：3 个门面导出类型 + 族内 4 个私有方法 +
 * 3 个 public 方法 + 只被本族使用的 3 个私有 helper。与 sessionService **同层（L2）**。
 *
 * 依赖方向**单向**：本模块 ← sessionService（本模块**不** import sessionService，
 * 含 `import type` 也不允许）。族外的 5 项能力经 `TranscriptDerivationHost` 注入，
 * 真源仍是 sessionService（`findSessionFile` 依赖其索引模式状态；
 * `readJsonlFile` 是其既有**测试接缝**字段，测试会替换以计数读取，故必须注入而非直引）。
 * 其余纯函数/常量按原样从同一来源 import（sessionService 里它们本就只是模块级导入）。
 */

import type { ContentBlock, RawEntry } from './session/transcriptAgents.js'
import type { SessionFileMatch } from './localIndex/sessionIndex.js'
import {
  MODEL_CONTEXT_WINDOW_DEFAULT,
  getContextWindowForModel,
  getModelMaxOutputTokens,
  is1mContextDisabled,
} from '../../utils/context.js'
import {
  MODEL_CONTEXT_WINDOWS_ENV_KEY,
  getModelContextWindowFromEnvValue,
} from '../../utils/model/modelContextWindows.js'
import { calculateContextBudget, getProviderUsageTrust, hasMediaInput } from '../../utils/contextBudget.js'
import { getCanonicalName } from '../../utils/model/model.js'
import { isFirstPartyAnthropicBaseUrl } from '../../utils/model/providers.js'
import { calculateUSDCost, MODEL_COSTS } from '../../utils/modelCost.js'
import { roughTokenCountEstimationForMessage } from '../../services/tokenEstimation.js'
import type { PersistedWorktreeSession } from './localIndex/types.js'
import type { PreparedSessionWorkspace } from './repositoryLaunchService.js'
import {
  appendJsonlEntry,
  appendSubagentToolMessages,
  getProjectsDir,
  sanitizePath,
  streamJsonlFile,
  subagentTranscriptPath,
} from './session/jsonlStorage.js'
import { normalizeDriveRootPathForPlatform } from './windowsDrivePath.js'
import { ApiError } from '../middleware/errorHandler.js'
import { createReadStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createInterface } from 'node:readline'
import * as path from 'node:path'
import { entriesToMessages, normalizeMessageUsage } from './session/messageConversion.js'
import { isVisibleTranscriptMessageEntry } from './session/transcriptEntries.js'
import {
  parsePersistedTaskNotification,
  parseTaskNotificationContent,
} from './session/transcriptContent.js'
import type { FileHistorySnapshot } from '../../utils/fileHistory.js'
import {
  extractAgentIdFromResultText,
  extractAgentToolUseId,
  extractTextFromContent,
} from './session/transcriptAgents.js'
import { sessionSummaryIndexStore, type SessionUsageTotals } from './sessionSummaryIndexStore.js'
import { ProviderService } from './providerService.js'
import { formatCost, isValidSessionId } from './session/sessionUtils.js'
import {
  applyRuntimeContextMetadata,
  countTranscriptMessages,
  desanitizePath,
  resolvePermissionModeFromEntries,
  resolveRepositoryFromEntries,
  resolveWorkDirFromEntries,
  resolveRuntimeContextMetadataFromEntries,
  VALID_SESSION_PERMISSION_MODES,
} from './session/sessionEntryMetadata.js'

export type TranscriptUsageSnapshot = {
  source: 'transcript'
  totalCostUSD: number
  costDisplay: string
  hasUnknownModelCost: boolean
  totalAPIDuration: number
  totalDuration: number
  totalLinesAdded: number
  totalLinesRemoved: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadInputTokens: number
  totalCacheCreationInputTokens: number
  totalWebSearchRequests: number
  models: Array<{
    model: string
    displayName: string
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
    webSearchRequests: number
    costUSD: number
    costDisplay: string
    contextWindow: number
    maxOutputTokens: number
  }>
}

export type TranscriptMetadataSnapshot = {
  model?: string
  cwd?: string
  version?: string
}

export type TranscriptContextEstimate = {
  categories: Array<{
    name: string
    tokens: number
    color: string
    isDeferred?: boolean
  }>
  totalTokens: number
  maxTokens: number
  rawMaxTokens: number
  percentage: number
  gridRows: Array<Array<{
    color: string
    isFilled: boolean
    categoryName: string
    tokens: number
    percentage: number
    squareFullness: number
  }>>
  model: string
  memoryFiles: Array<{ path: string; type: string; tokens: number }>
  mcpTools: Array<{ name: string; serverName: string; tokens: number; isLoaded?: boolean }>
  agents: Array<{ agentType: string; source: string; tokens: number }>
  apiUsage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  }
}

const PROVIDER_MODEL_ALIAS_SEPARATORS = ['-', '_', ':', '/', '.', ' ']

function normalizeProviderModelAlias(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/\[1m\]$/i, '')
    .replace(/:1m$/i, '')
    .trim()
}

function providerModelLooksRelated(
  transcriptModel: string,
  configuredModel: string,
): boolean {
  const transcript = normalizeProviderModelAlias(transcriptModel)
  const configured = normalizeProviderModelAlias(configuredModel)
  if (!transcript || !configured) return false
  if (transcript === configured) return true

  const shorter = Math.min(transcript.length, configured.length)
  if (shorter < 6) return false

  return PROVIDER_MODEL_ALIAS_SEPARATORS.some((separator) => (
    transcript.startsWith(`${configured}${separator}`) ||
    configured.startsWith(`${transcript}${separator}`)
  ))
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

export type SessionInspectionTranscriptSnapshot = {
  launchInfo: SessionLaunchInfo
  metadata: TranscriptMetadataSnapshot
  usage: TranscriptUsageSnapshot | null
  contextEstimate: TranscriptContextEstimate | null
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

type UsageAccumulator = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

function safeJsonLength(value: unknown): number {
  if (value === undefined) return 0
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

/** 任务通知条目类型标记（随族④ 搬来；全仓只此族使用） */
const PERSISTED_TASK_NOTIFICATION_ENTRY_TYPE = 'cc-heihei-task-notification'

export type TrimSessionResult = {
  removedCount: number
  removedMessageIds: string[]
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

/**
 * launch 提示的最小结构面（= sessionEntryMetadata 里 `ProviderContextWindowHint` 的同形定义）。
 * 那边**刻意不导出**该类型（见 sessionService 的对应注释），本模块若 import 会把它的既存
 * TS2459（declares locally, but is not exported）复制一份 ⇒ 本模块自带同形类型（两字段可选，
 * 结构等价），`SessionLaunchInfo` / `ProviderContextWindowHint` 均可直接赋入。
 */
export type TranscriptDerivationLaunchHint = {
  runtimeProviderId?: string | null
  runtimeModelId?: string
}

/**
 * 注入缝：本族所需的族外能力（实现仍在 sessionService，真源唯一）。
 * 四项全部惰性取用（箭头在调用时才读 `this.xxx`），故字段初始化次序无关。
 */
export type TranscriptDerivationHost = {
  /** providerService 单例（读 provider 运行时 env / provider 列表） */
  providerService: ProviderService
  /** 读 JSONL 全文；sessionService 的实例字段（**测试接缝**，会被替换计数） */
  readJsonlFile: (filePath: string) => Promise<RawEntry[]>
  /** 定位会话转录文件；依赖 sessionService 的索引模式实例状态 ⇒ 以函数注入 */
  findSessionFile: (sessionId: string) => Promise<SessionFileMatch | null>
  /** 失效会话列表缓存；族外另有 4 处调用点（会话列表族）⇒ 不随族 */
  invalidateSessionListCache: () => void
  /** 找同名会话的全部文件；:1519 的 findSessionFile 也用它 ⇒ 不随族 */
  findSessionFiles: (sessionId: string) => Promise<Array<{ filePath: string; projectDir: string }>>
  /** 按类型定向读条目；内部依赖 local index 机制（getUsableIndexMode /
   *  localIndexGateway / markIndexReadFailure / targetedEntryReader）⇒ 不随族 */
  readTargetedJsonlEntries: (
    found: { filePath: string; projectDir: string },
    entryTypes: string[],
  ) => Promise<RawEntry[] | null>
  /** 只读时钟（构造选项可注入）⇒ 保持单一真源，不随族 */
  now: () => number
  /** 会话 effort 档位白名单；该常量在 sessionService 另有族外使用点（:658/:2942/:3086）
   *  ⇒ 不随本族搬（以免重复定义），经宿主注入。 */
  sessionEffortLevels: ReadonlySet<string>
  /** 族外方法（P2-a 加固过）；返回**完整** SessionLaunchInfo——族④ 的
   *  metadataMatchesLaunchInfo 要逐字段比对（workDir/repository/permissionMode/…），
   *  窄化的 LaunchHint 不足以赋值 ⇒ 这里用精确类型 */
  getSessionLaunchInfo: (sessionId: string) => Promise<SessionLaunchInfo | null>
}

export class TranscriptDerivation {
  constructor(private host: TranscriptDerivationHost) {}

  private async getProviderContextWindowForSession(
    sessionId: string,
    model: string,
    launchInfoOverride?: TranscriptDerivationLaunchHint | null,
  ): Promise<number | undefined> {
    const launchInfo = launchInfoOverride ?? await this.host.getSessionLaunchInfo(sessionId).catch(() => null)
    const providerIds: string[] = []
    const allowSavedProviderInference = launchInfo?.runtimeProviderId === undefined

    if (typeof launchInfo?.runtimeProviderId === 'string') {
      providerIds.push(launchInfo.runtimeProviderId)
    } else if (launchInfo?.runtimeProviderId !== null) {
      const { activeId } = await this.host.providerService.listProviders().catch(() => ({ activeId: null }))
      if (activeId) providerIds.push(activeId)
    }

    // Provider env model keys — these are the configured model names that
    // should be used as fallback matching keys when the transcript model name
    // (from the API response) doesn't match the modelContextWindows keys.
    // Third-party APIs may return model names with provider-specific suffixes
    // (e.g. "LongCat-2.0-Preview-LongCatAI" instead of "LongCat-2.0-Preview").
    const providerEnvModelKeys = [
      'ANTHROPIC_MODEL',
      'ANTHROPIC_DEFAULT_FABLE_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
    ] as const

    for (const providerId of providerIds) {
      const env = await this.host.providerService.getProviderRuntimeEnv(providerId).catch(() => null)
      const rawContextWindows = env?.[MODEL_CONTEXT_WINDOWS_ENV_KEY] ?? null
      // Step 1: Try matching the transcript model name directly (current behavior)
      const contextWindow = getModelContextWindowFromEnvValue(
        model,
        rawContextWindows,
      )
      if (contextWindow !== undefined) {
        if (contextWindow > MODEL_CONTEXT_WINDOW_DEFAULT && is1mContextDisabled()) {
          return MODEL_CONTEXT_WINDOW_DEFAULT
        }
        return contextWindow
      }

      // Step 2: Prefer the model this session actually launched with. Some
      // third-party APIs return provider-specific aliases, but Desktop persists
      // the requested runtime model in session metadata.
      if (launchInfo?.runtimeModelId) {
        const runtimeModelWindow = getModelContextWindowFromEnvValue(
          launchInfo.runtimeModelId,
          rawContextWindows,
        )
        if (runtimeModelWindow !== undefined) {
          if (runtimeModelWindow > MODEL_CONTEXT_WINDOW_DEFAULT && is1mContextDisabled()) {
            return MODEL_CONTEXT_WINDOW_DEFAULT
          }
          return runtimeModelWindow
        }
      }

      // Step 3: If transcript model name didn't match, try matching with
      // the provider's configured model names as fallback keys.
      // This handles the case where the API response returns a model name
      // that differs from the user-configured model name (e.g. provider
      // appends its own suffix like "-LongCatAI").
      if (env && rawContextWindows) {
        for (const envKey of providerEnvModelKeys) {
          const configuredModel = env[envKey]
          if (!configuredModel) continue
          if (!providerModelLooksRelated(model, configuredModel)) continue
          const fallbackWindow = getModelContextWindowFromEnvValue(
            configuredModel,
            rawContextWindows,
          )
          if (fallbackWindow !== undefined) {
            if (fallbackWindow > MODEL_CONTEXT_WINDOW_DEFAULT && is1mContextDisabled()) {
              return MODEL_CONTEXT_WINDOW_DEFAULT
            }
            return fallbackWindow
          }
        }
      }
    }

    if (allowSavedProviderInference) {
      return this.getUniqueSavedProviderContextWindow(model)
    }

    return undefined
  }

  private async getUniqueSavedProviderContextWindow(model: string): Promise<number | undefined> {
    const { providers } = await this.host.providerService.listProviders().catch(() => ({ providers: [] }))
    const matches: number[] = []
    const providerEnvModelKeys = [
      'ANTHROPIC_MODEL',
      'ANTHROPIC_DEFAULT_FABLE_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
    ] as const

    for (const provider of providers) {
      const env = await this.host.providerService.getProviderRuntimeEnv(provider.id).catch(() => null)
      const rawContextWindows = env?.[MODEL_CONTEXT_WINDOWS_ENV_KEY] ?? null
      // Step 1: Try matching the transcript model name directly
      const contextWindow = getModelContextWindowFromEnvValue(
        model,
        rawContextWindows,
      )
      if (contextWindow !== undefined) {
        matches.push(contextWindow)
        continue
      }

      // Step 2: Fallback to provider configured model names.
      if (env && rawContextWindows) {
        for (const envKey of providerEnvModelKeys) {
          const configuredModel = env[envKey]
          if (!configuredModel) continue
          if (!providerModelLooksRelated(model, configuredModel)) continue
          const fallbackWindow = getModelContextWindowFromEnvValue(
            configuredModel,
            rawContextWindows,
          )
          if (fallbackWindow !== undefined) {
            matches.push(fallbackWindow)
            break // One match per provider is enough
          }
        }
      }
    }

    if (matches.length === 0) {
      return undefined
    }

    const uniqueWindows = new Set(matches)
    if (uniqueWindows.size !== 1) {
      return undefined
    }

    const contextWindow = [...uniqueWindows][0]!
    if (
      contextWindow > MODEL_CONTEXT_WINDOW_DEFAULT &&
      is1mContextDisabled()
    ) {
      return MODEL_CONTEXT_WINDOW_DEFAULT
    }
    return contextWindow
  }

  private async getTranscriptContextWindow(
    sessionId: string,
    model: string,
    launchInfo?: TranscriptDerivationLaunchHint | null,
  ): Promise<number> {
    const providerContextWindow = await this.getProviderContextWindowForSession(
      sessionId,
      model,
      launchInfo,
    )
    if (providerContextWindow !== undefined) {
      return providerContextWindow
    }

    try {
      return getContextWindowForModel(model)
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes('Config accessed before allowed')
      ) {
        return MODEL_CONTEXT_WINDOW_DEFAULT
      }
      throw err
    }
  }

  async getTranscriptMetadata(sessionId: string): Promise<TranscriptMetadataSnapshot | null> {
    const found = await this.host.findSessionFile(sessionId)
    if (!found) return null

    const entries = await this.host.readJsonlFile(found.filePath)
    const metadata: TranscriptMetadataSnapshot = {}

    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]!
      if (!metadata.model && typeof entry.message?.model === 'string') {
        metadata.model = entry.message.model
      }
      if (!metadata.cwd && typeof entry.cwd === 'string') {
        metadata.cwd = entry.cwd
      }
      if (!metadata.version && typeof entry.version === 'string') {
        metadata.version = entry.version
      }
      if (metadata.model && metadata.cwd && metadata.version) break
    }

    return metadata
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
    launchInfo?: TranscriptDerivationLaunchHint | null,
  ): Promise<TranscriptContextEstimate> {
    const rawMaxTokens = await this.getTranscriptContextWindow(sessionId, latest.model, launchInfo)
    const promptTokens = latest.inputTokens + latest.cacheReadInputTokens + latest.cacheCreationInputTokens
    const estimatedTokens = estimatedTokensFromMessages || promptTokens
    const contextBudget = calculateContextBudget({
      estimatedTokens,
      contextWindow: rawMaxTokens,
      currentUsage: {
        input_tokens: latest.inputTokens,
        output_tokens: latest.outputTokens,
        cache_read_input_tokens: latest.cacheReadInputTokens,
        cache_creation_input_tokens: latest.cacheCreationInputTokens,
      },
      usageTrust: getProviderUsageTrust({
        isFirstPartyAnthropic: isFirstPartyAnthropicBaseUrl(),
      }),
      hasMediaInput: transcriptHasMediaInput,
    })
    const totalTokens = contextBudget.usedTokens
    const percentage = rawMaxTokens > 0 ? Math.round((totalTokens / rawMaxTokens) * 100) : 0
    const usageCategories: TranscriptContextEstimate['categories'] = [
      { name: 'Input tokens', tokens: latest.inputTokens, color: '#8f3217' },
      { name: 'Cache read', tokens: latest.cacheReadInputTokens, color: '#0f5c8f' },
      { name: 'Cache write', tokens: latest.cacheCreationInputTokens, color: '#7c3aed' },
      { name: 'Output tokens', tokens: latest.outputTokens, color: '#2f7d32' },
    ]
    const contextCategories: TranscriptContextEstimate['categories'] =
      contextBudget.ignoredUsageReason === 'low_trust_media_usage'
        ? [{ name: 'Estimated context', tokens: totalTokens, color: '#8f3217' }]
        : usageCategories
    const categories: TranscriptContextEstimate['categories'] = [
      ...contextCategories,
      { name: 'Free space', tokens: Math.max(0, rawMaxTokens - totalTokens), color: '#a1a1aa', isDeferred: true },
    ].filter((category) => category.tokens > 0)

    const filledSquares = Math.max(0, Math.min(100, Math.round((totalTokens / Math.max(1, rawMaxTokens)) * 100)))
    const gridRows = Array.from({ length: 10 }, (_, row) =>
      Array.from({ length: 10 }, (_, col) => {
        const index = row * 10 + col
        const isFilled = index < filledSquares
        return {
          color: isFilled ? '#8f3217' : '#a1a1aa',
          isFilled,
          categoryName: isFilled ? 'Input context' : 'Free space',
          tokens: Math.round(rawMaxTokens / 100),
          percentage: 1,
          squareFullness: isFilled ? 1 : 0,
        }
      }),
    )

    return {
      categories,
      totalTokens,
      maxTokens: rawMaxTokens,
      rawMaxTokens,
      percentage,
      gridRows,
      model: latest.model,
      memoryFiles: [],
      mcpTools: [],
      agents: [],
      apiUsage: {
        input_tokens: latest.inputTokens,
        output_tokens: latest.outputTokens,
        cache_creation_input_tokens: latest.cacheCreationInputTokens,
        cache_read_input_tokens: latest.cacheReadInputTokens,
      },
    }
  }

  async getTranscriptContextEstimate(sessionId: string): Promise<TranscriptContextEstimate | null> {
    const found = await this.host.findSessionFile(sessionId)
    if (!found) return null

    const entries = await this.host.readJsonlFile(found.filePath)
    let latest: {
      model: string
      inputTokens: number
      outputTokens: number
      cacheReadInputTokens: number
      cacheCreationInputTokens: number
    } | null = null
    let estimatedTokensFromMessages = 0
    let transcriptHasMediaInput = false

    for (const entry of entries) {
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
      if (!usage || typeof model !== 'string') continue

      const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0
      const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0
      const cacheReadInputTokens = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0
      const cacheCreationInputTokens = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0

      latest = {
        model,
        inputTokens,
        outputTokens,
        cacheReadInputTokens,
        cacheCreationInputTokens,
      }
    }

    if (!latest) return null

    return await this.buildTranscriptContextEstimate(
      sessionId,
      latest,
      estimatedTokensFromMessages,
      transcriptHasMediaInput,
      resolveRuntimeContextMetadataFromEntries(entries),
    )
  }

  async getTranscriptUsage(sessionId: string): Promise<TranscriptUsageSnapshot | null> {
    const found = await this.host.findSessionFile(sessionId)
    if (!found) return null

    const entries = await this.host.readJsonlFile(found.filePath)
    let currentRuntimeHint: TranscriptDerivationLaunchHint = {}
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

    for (const entry of entries) {
      currentRuntimeHint = applyRuntimeContextMetadata(currentRuntimeHint, entry)
      const usage = entry.message?.usage
      const model = entry.message?.model
      if (!usage || typeof model !== 'string') continue

      const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0
      const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0
      const cacheReadInputTokens = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0
      const cacheCreationInputTokens = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0
      const webSearchRequests = typeof usage.server_tool_use?.web_search_requests === 'number'
        ? usage.server_tool_use.web_search_requests
        : 0

      if (
        inputTokens === 0 &&
        outputTokens === 0 &&
        cacheReadInputTokens === 0 &&
        cacheCreationInputTokens === 0 &&
        webSearchRequests === 0
      ) {
        continue
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
          contextWindow: await this.getTranscriptContextWindow(sessionId, model, currentRuntimeHint),
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
      modelUsage.costDisplay = formatCost(modelUsage.costUSD)

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
    }

    if (models.size === 0) return null

    return {
      source: 'transcript',
      totalCostUSD,
      costDisplay: formatCost(totalCostUSD),
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
  }

  async getInspectionTranscriptSnapshot(sessionId: string): Promise<SessionInspectionTranscriptSnapshot | null> {
    const found = await this.host.findSessionFile(sessionId)
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

    await streamJsonlFile(found.filePath, (entry) => {
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
          this.host.sessionEffortLevels.has(record.effortLevel)
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
      modelUsage.costDisplay = formatCost(modelUsage.costUSD)

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

    const workDir = latestWorkDir || latestCwd || desanitizePath(found.projectDir) || process.cwd()
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
          costDisplay: formatCost(totalCostUSD),
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

  async getSessionMessages(sessionId: string): Promise<MessageEntry[]> {
    const found = await this.host.findSessionFile(sessionId)
    if (!found) {
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }

    const entries = await this.host.readJsonlFile(found.filePath)
    return await appendSubagentToolMessages(
      found.projectDir,
      sessionId,
      entriesToMessages(entries),
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
    const found = await this.host.findSessionFile(sessionId)
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

    const messages = await appendSubagentToolMessages(
      found.projectDir,
      sessionId,
      entriesToMessages(window.entries),
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
    const found = await this.host.findSessionFile(sessionId)
    if (!found) {
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }

    const entries = await this.host.readJsonlFile(
      subagentTranscriptPath(found.projectDir, sessionId, agentId),
    )
    return entriesToMessages(entries)
  }

  async getSessionMessagesSignature(sessionId: string): Promise<string | null> {
    const found = await this.host.findSessionFile(sessionId)
    if (!found) return null

    let count = 0
    let last = ''
    const agentToolUseIds = new Set<string>()
    const resultLinks = new Map<string, string>()
    await streamJsonlFile(found.filePath, (entry) => {
      const agentToolUseId = extractAgentToolUseId(entry)
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
          const agentId = extractAgentIdFromResultText(
            extractTextFromContent(block.content),
          )
          if (agentId) {
            resultLinks.set(block.tool_use_id, agentId)
          }
        }
      }
      if (!isVisibleTranscriptMessageEntry(entry)) return
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
        await streamJsonlFile(subagentTranscriptPath(found.projectDir, sessionId, agentId), (entry) => {
          if (!isVisibleTranscriptMessageEntry(entry)) return
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
      this.host.sessionEffortLevels.has(metadata.effortLevel) &&
      launchInfo.effortLevel !== metadata.effortLevel
    ) {
      return false
    }
    return true
  }

  async deleteSessionFile(sessionId: string): Promise<void> {
    const found = await this.host.findSessionFile(sessionId)
    if (!found) return
    await fs.unlink(found.filePath)
    this.host.invalidateSessionListCache()
  }

  async clearSessionTranscript(
    sessionId: string,
    fallbackWorkDir?: string,
    preservedPermissionMode?: string,
  ): Promise<void> {
    let found = await this.host.findSessionFile(sessionId)
    if (!found && fallbackWorkDir) {
      const resolvedPath = path.resolve(normalizeDriveRootPathForPlatform(fallbackWorkDir))
      const absWorkDir = await fs.realpath(resolvedPath).catch(() => resolvedPath)
      const dirPath = path.join(getProjectsDir(), sanitizePath(absWorkDir))
      await fs.mkdir(dirPath, { recursive: true })
      found = {
        filePath: path.join(dirPath, `${sessionId}.jsonl`),
        projectDir: sanitizePath(absWorkDir),
      }
    }
    if (!found) {
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }

    const entries = await this.host.readJsonlFile(found.filePath)
    const workDir = resolveWorkDirFromEntries(entries, found.projectDir) || fallbackWorkDir || process.cwd()
    const repository = resolveRepositoryFromEntries(entries)
    const permissionMode = (
      preservedPermissionMode &&
      VALID_SESSION_PERMISSION_MODES.has(preservedPermissionMode)
    )
      ? preservedPermissionMode
      : resolvePermissionModeFromEntries(entries)
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
    this.host.invalidateSessionListCache()
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
    const matches = await this.host.findSessionFiles(sessionId)
    if (matches.length === 0) return

    let repository = metadata.repository
    if (!repository) {
      for (const match of matches) {
        const candidate = resolveRepositoryFromEntries(await this.host.readJsonlFile(match.filePath))
        if (candidate) {
          repository = candidate
          break
        }
      }
    }

    const normalizedWorkDir = normalizeDriveRootPathForPlatform(metadata.workDir)
    const targetProjectDir = sanitizePath(normalizedWorkDir)
    const targetFilePath = path.join(getProjectsDir(), targetProjectDir, `${sessionId}.jsonl`)

    if (!metadata.customTitle) {
      const launchInfo = await this.host.getSessionLaunchInfo(sessionId)
      if (this.metadataMatchesLaunchInfo(launchInfo, {
        ...metadata,
        workDir: normalizedWorkDir,
        repository,
      })) {
        return
      }
    }

    await fs.mkdir(path.dirname(targetFilePath), { recursive: true })

    await appendJsonlEntry(targetFilePath, {
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
      ...(metadata.effortLevel && this.host.sessionEffortLevels.has(metadata.effortLevel)
        ? { effortLevel: metadata.effortLevel }
        : {}),
      timestamp: new Date().toISOString(),
    })

    if (metadata.customTitle) {
      await appendJsonlEntry(targetFilePath, {
        type: 'custom-title',
        customTitle: metadata.customTitle,
        timestamp: new Date().toISOString(),
      })
    }
    this.host.invalidateSessionListCache()
  }

  async deletePlaceholderSessionFiles(
    sessionId: string,
    keepWorkDir: string,
  ): Promise<number> {
    if (!isValidSessionId(sessionId)) return 0

    const projectsDir = getProjectsDir()
    let projectDirs: import('node:fs').Dirent[]
    try {
      projectDirs = await fs.readdir(projectsDir, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw err
    }

    const keepProjectDir = sanitizePath(normalizeDriveRootPathForPlatform(keepWorkDir))
    let removed = 0
    for (const projectDir of projectDirs) {
      if (!projectDir.isDirectory()) continue
      if (projectDir.name === keepProjectDir) continue
      const filePath = path.join(projectsDir, projectDir.name, `${sessionId}.jsonl`)
      const entries = await this.host.readJsonlFile(filePath)
      if (entries.length === 0) continue

      if (countTranscriptMessages(entries) > 0) continue

      await fs.rm(filePath, { force: true })
      removed += 1
    }
    if (removed > 0) this.host.invalidateSessionListCache()
    return removed
  }

  async trimSessionMessagesFrom(
    sessionId: string,
    startMessageId: string,
  ): Promise<TrimSessionResult> {
    const found = await this.host.findSessionFile(sessionId)
    if (!found) {
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }

    const entries = await this.host.readJsonlFile(found.filePath)
    const activeMessages = entriesToMessages(entries)
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
    this.host.invalidateSessionListCache()

    return {
      removedCount: removedMessageIds.length,
      removedMessageIds,
    }
  }

  async getSessionFileHistorySnapshots(
    sessionId: string,
  ): Promise<FileHistorySnapshot[]> {
    const found = await this.host.findSessionFile(sessionId)
    if (!found) {
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }

    const entries = await this.host.readTargetedJsonlEntries(
      found,
      ['file-history-snapshot'],
    ) ?? await this.host.readJsonlFile(found.filePath)
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
    const normalized = parsePersistedTaskNotification(
      notification,
      notification.timestamp ?? new Date(this.host.now()).toISOString(),
    )
    if (!normalized) return

    const found = await this.host.findSessionFile(sessionId)
    if (!found) return

    await appendJsonlEntry(found.filePath, {
      type: PERSISTED_TASK_NOTIFICATION_ENTRY_TYPE,
      isMeta: true,
      taskNotification: normalized,
      timestamp: normalized.timestamp,
    })
    this.host.invalidateSessionListCache()
  }

  async getSessionTaskNotifications(
    sessionId: string,
  ): Promise<SessionTaskNotification[]> {
    const found = await this.host.findSessionFile(sessionId)
    if (!found) {
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }

    const entries = await this.host.readTargetedJsonlEntries(
      found,
      ['user', PERSISTED_TASK_NOTIFICATION_ENTRY_TYPE],
    ) ?? await this.host.readJsonlFile(found.filePath)
    const notifications = new Map<string, SessionTaskNotification>()
    for (const entry of entries) {
      const notification = entry.type === PERSISTED_TASK_NOTIFICATION_ENTRY_TYPE
        ? parsePersistedTaskNotification(entry.taskNotification, entry.timestamp)
        : entry.message?.role === 'user'
          ? parseTaskNotificationContent(entry.message.content, entry.timestamp)
          : null
      if (notification) notifications.set(notification.toolUseId, notification)
    }
    return [...notifications.values()]
  }

}
