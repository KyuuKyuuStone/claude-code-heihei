/**
 * 转录派生域（v1.7.4 结构专项 · B2 族①：上下文窗口/用量族）
 *
 * 从 `sessionService.ts` 整簇外移：3 个门面导出类型 + 族内 4 个私有方法 +
 * 3 个 public 方法 + 只被本族使用的 3 个私有 helper。与 sessionService **同层（L2）**。
 *
 * 依赖方向**单向**：本模块 ← sessionService（本模块**不** import sessionService，
 * 含 `import type` 也不允许）。族外的 4 项能力经 `TranscriptDerivationHost` 注入，
 * 真源仍是 sessionService（`findSessionFile` 依赖其索引模式状态；
 * `readJsonlFile` 是其既有**测试接缝**字段，测试会替换以计数读取，故必须注入而非直引）。
 * 其余纯函数/常量按原样从同一来源 import（sessionService 里它们本就只是模块级导入）。
 */

import type { RawEntry } from './session/transcriptAgents.js'
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
import { streamJsonlFile } from './session/jsonlStorage.js'
import { normalizeDriveRootPathForPlatform } from './windowsDrivePath.js'
import { ProviderService } from './providerService.js'
import { formatCost } from './session/sessionUtils.js'
import {
  applyRuntimeContextMetadata,
  desanitizePath,
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
  /** 会话 effort 档位白名单；该常量在 sessionService 另有族外使用点（:658/:2942/:3086）
   *  ⇒ 不随本族搬（以免重复定义），经宿主注入。 */
  sessionEffortLevels: ReadonlySet<string>
  /** 族外方法（P2-a 加固过），本族仅 1 处调用 */
  getSessionLaunchInfo: (sessionId: string) => Promise<TranscriptDerivationLaunchHint | null>
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

}
