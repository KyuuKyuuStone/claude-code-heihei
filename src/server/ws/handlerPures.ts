/**
 * handler.ts 的零依赖纯函数簇（v1.7.1 结构拆分 · Wave1 批B · 架构师补充裁决十七）。
 *
 * 纯移动：以下函数**逐字**从 handler.ts 搬来（含各自专属 JSDoc），仅新增 `export` 前缀；
 * 同目录，故引用它们的相对路径说明符逐字不变。门面以「一名一行」的具名 import 接回。
 */

import * as os from 'node:os'
import { conversationService } from '../services/conversationService.js'
import { sessionService } from '../services/sessionService.js'
import type { SessionTaskNotification } from '../services/sessionService.js'
import { registerSession } from '../services/sessionRegistry.js'
import { beginTurnReplacing as registryBeginTurnReplacing } from '../services/sessionRegistry.js'
import type { TurnHandle } from '../services/sessionRegistry.js'
import { getOpenAICodexModelCatalog } from '../../services/openaiAuth/modelCatalog.js'
import { getOpenAIModelCatalogEntry } from '../../services/openaiAuth/models.js'
import { heiheiGrokOAuthService } from '../services/heiheiGrokOAuthService.js'
import { getGrokModelCatalog } from '../../services/grokAuth/modelCatalog.js'
import { GROK_DEFAULT_MAIN_MODEL } from '../../services/grokAuth/models.js'

export async function persistSessionPermissionMode(
  sessionId: string,
  mode: string,
  knownWorkDir?: string | null,
): Promise<boolean> {
  const workDir =
    knownWorkDir ||
    conversationService.getSessionWorkDir(sessionId) ||
    await sessionService.getSessionWorkDir(sessionId).catch(() => null)

  if (!workDir) return false

  await sessionService.appendSessionMetadata(sessionId, {
    workDir,
    permissionMode: mode,
  })
  return true
}

export async function persistSessionRuntimeConfig(
  sessionId: string,
  runtime: { providerId: string | null; modelId: string; effort?: string },
): Promise<void> {
  const workDir =
    conversationService.getSessionWorkDir(sessionId) ||
    await sessionService.getSessionWorkDir(sessionId).catch(() => null)

  if (!workDir) return

  await sessionService.appendSessionMetadata(sessionId, {
    workDir,
    runtimeProviderId: runtime.providerId,
    runtimeModelId: runtime.modelId,
    ...(runtime.effort ? { effortLevel: runtime.effort } : {}),
  })
}

export function extractAssistantStreamTextForTitle(cliMsg: any): string | null {
  const event = cliMsg?.event
  if (
    cliMsg?.type !== 'stream_event' ||
    event?.type !== 'content_block_delta' ||
    event.delta?.type !== 'text_delta' ||
    typeof event.delta.text !== 'string'
  ) {
    return null
  }
  return event.delta.text
}

export function extractAssistantMessageTextForTitle(cliMsg: any): string | null {
  if (cliMsg?.type !== 'assistant') return null
  const content = cliMsg.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const text = content
    .flatMap((block) => {
      if (!block || typeof block !== 'object') return []
      const typedBlock = block as { type?: unknown; text?: unknown }
      return typedBlock.type === 'text' && typeof typedBlock.text === 'string'
        ? [typedBlock.text]
        : []
    })
    .join('\n')
    .trim()
  return text || null
}

export function normalizeCliTaskNotification(cliMsg: any): SessionTaskNotification | null {
  if (cliMsg?.type !== 'system' || cliMsg.subtype !== 'task_notification') return null
  const toolUseId = typeof cliMsg.tool_use_id === 'string' && cliMsg.tool_use_id
    ? cliMsg.tool_use_id
    : null
  const rawStatus = cliMsg.status
  const status = rawStatus === 'killed' ? 'stopped' : rawStatus
  if (
    !toolUseId ||
    (status !== 'completed' && status !== 'failed' && status !== 'stopped')
  ) {
    return null
  }

  const optionalString = (value: unknown) =>
    typeof value === 'string' && value ? value : undefined
  return {
    taskId: optionalString(cliMsg.task_id) ?? toolUseId,
    toolUseId,
    status,
    ...(optionalString(cliMsg.summary) ? { summary: optionalString(cliMsg.summary) } : {}),
    ...(optionalString(cliMsg.result) ? { result: optionalString(cliMsg.result) } : {}),
    ...(optionalString(cliMsg.output_file) ? { outputFile: optionalString(cliMsg.output_file) } : {}),
    timestamp: optionalString(cliMsg.timestamp) ?? new Date().toISOString(),
  }
}

export async function getDefaultOpenAIReasoningEffort(modelId: string): Promise<string> {
  const catalog = await getOpenAICodexModelCatalog()
  return getOpenAIModelCatalogEntry(modelId, catalog)?.defaultReasoningEffort ?? 'medium'
}

export async function getGrokReasoningEfforts(modelId: string): Promise<{
  modelId: string
  defaultEffort?: string
  supportedEfforts: string[]
}> {
  const tokens = await heiheiGrokOAuthService.ensureFreshTokens()
  const catalog = await getGrokModelCatalog({
    ...(tokens?.accessToken ? { accessToken: tokens.accessToken } : {}),
    accountKey: tokens?.email ?? (tokens ? 'authenticated-default' : 'logged-out'),
  })
  const model = catalog.find((entry) => entry.value === modelId)
    ?? catalog.find((entry) => entry.value === GROK_DEFAULT_MAIN_MODEL)
    ?? catalog[0]
  return {
    modelId: model?.value ?? GROK_DEFAULT_MAIN_MODEL,
    ...(model?.reasoningEffort ? { defaultEffort: model.reasoningEffort } : {}),
    supportedEfforts: model?.reasoningEfforts ?? [],
  }
}

export async function resolveSessionWorkDir(sessionId: string, fallback = os.homedir()): Promise<string> {
  let workDir = fallback
  try {
    const resolved = await sessionService.getSessionWorkDir(sessionId)
    if (resolved) workDir = resolved
    console.log(
      `[WS] resolveSessionWorkDir: sessionId=${sessionId}, resolved workDir=${JSON.stringify(
        resolved,
      )}, will spawn CLI with workDir=${workDir}`,
    )
  } catch (resolveErr) {
    console.warn(
      `[WS] resolveSessionWorkDir: failed to resolve workDir for ${sessionId}, using fallback=${workDir}: ${
        resolveErr instanceof Error ? resolveErr.message : String(resolveErr)
      }`,
    )
  }
  return workDir
}

export function extractAssistantText(cliMsg: any): string {
  const content = cliMsg?.message?.content
  if (!Array.isArray(content)) return ''
  const textBlock = content.find(
    (block: unknown): block is { type: string; text: string } =>
      !!block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string',
  )
  return textBlock?.text || ''
}

export function readObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/**
 * 确保会话已在 registry 登记（幂等）：阶段 1 只收 turn，turn 生命周期尚不依赖
 * registry 的 phase 接线（阶段 2/3 统一登记来源），因此 turn 建立前先补登记，
 * 与旧行为「activeUserTurns 无条件 set（不论会话是否在 conversationService）」对齐。
 */
export function ensureSessionRegistered(sessionId: string): void {
  registerSession(sessionId)
}

/**
 * 替换式建回合（WS user_message 语义保真）：旧行为是 activeUserTurns.set 直接
 * 覆盖——同 session 并发第二条 user_message 会让新 turn 顶掉旧 turn，且旧
 * handler 的收尾比对随之失效（websocket-handler 测试锁定的 replacement 语义）。
 * v1.5.0 低7：读-清-建合并进 registry 的原子导出（此前三步在 handler 侧非原子，
 * 并发双消息存在后到者 beginTurn 返回 null 的窄窗口）。
 */
export function beginTurnReplacing(sessionId: string, awaitSend: boolean): TurnHandle | null {
  return registryBeginTurnReplacing(sessionId, { awaitSend })
}

export function classifyRuntimeErrorCode(message: string, fallbackCode: string): string {
  if (/Stream max duration exceeded/i.test(message)) {
    return 'STREAM_MAX_DURATION'
  }
  if (
    /Provider stream stalled after partial response/i.test(message) ||
    /Stream idle timeout/i.test(message)
  ) {
    return 'STREAM_IDLE_TIMEOUT'
  }
  return fallbackCode
}
