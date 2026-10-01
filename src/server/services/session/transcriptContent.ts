/**
 * 转录内容分类与任务通知解析（v1.7 结构拆分 · sessionService 第①批 · 纯移动）。
 *
 * 从 sessionService.ts 原样搬出的 10 个方法 + 4 个只被它们使用的常量。
 * 选段理由：这是该文件里**唯一一段既不碰实例状态、也不依赖门面私有类型**的
 * 自洽职责——全部是 (unknown) → 判定/解析的纯函数，内部只有组内互调。
 *
 * 搬移规则：函数体逐字不变，仅两处形式调整——
 *   ① 缩进 −2（原 class 方法体缩进 4，模块级函数体缩进 2）；
 *   ② 组内互调 this.foo( → foo(。
 * 门面里这 10 个方法的位置改为同名类字段委托，**所有调用点（含组外
 * shouldHideTranscriptEntry / isGoalLocalCommandEntry / entriesToMessages）
 * 的 `this.xxx(...)` 文本一行未改**。
 *
 * 未随本批搬走的相邻项（有意保留在门面）：
 *   · PERSISTED_TASK_NOTIFICATION_ENTRY_TYPE：被组外 entriesToMessages 使用；
 *   · ContentBlock / PROVIDER_MODEL_ALIAS_SEPARATORS / normalizeProviderModelAlias /
 *     providerModelLooksRelated 等：属模型别名与通用类型，非本组职责。
 *
 * 路径依赖预检：本段无 import.meta / __dirname / process.execPath（全文预检亦为零）。
 */

import type { SessionTaskNotification } from '../sessionService.js'

const USER_INTERRUPTION_TEXTS = new Set([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
])

const NO_RESPONSE_REQUESTED_TEXT = 'No response requested.'
const TASK_NOTIFICATION_RE = /^<task-notification>\s*[\s\S]*<\/task-notification>$/i
const TASK_NOTIFICATION_BLOCK_RE = /<task-notification>\s*[\s\S]*?<\/task-notification>/i

export function extractTextBlocks(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []

  return content
    .flatMap((block) => {
      if (!block || typeof block !== 'object') return []
      const record = block as Record<string, unknown>
      return record.type === 'text' && typeof record.text === 'string'
        ? [record.text]
        : []
    })
    .map((text) => text.trim())
    .filter(Boolean)
}

export function isSyntheticUserInterruption(content: unknown): boolean {
  const textBlocks = extractTextBlocks(content)
  return (
    textBlocks.length > 0 &&
    textBlocks.every((text) => USER_INTERRUPTION_TEXTS.has(text))
  )
}

export function isSyntheticNoResponseAssistant(content: unknown): boolean {
  const textBlocks = extractTextBlocks(content)
  return (
    textBlocks.length > 0 &&
    textBlocks.every((text) => text === NO_RESPONSE_REQUESTED_TEXT)
  )
}

export function isToolResultContent(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some((block) =>
      block &&
      typeof block === 'object' &&
      (block as Record<string, unknown>).type === 'tool_result'
    )
  )
}

export function isTaskNotificationContent(content: unknown): boolean {
  const textBlocks = extractTextBlocks(content)
  return (
    textBlocks.length > 0 &&
    textBlocks.every((text) => extractTaskNotificationXml(text) !== null)
  )
}

export function extractTaskNotificationXml(text: string): string | null {
  const trimmed = text.trim()
  if (TASK_NOTIFICATION_RE.test(trimmed)) return trimmed
  return trimmed.match(TASK_NOTIFICATION_BLOCK_RE)?.[0] ?? null
}

export function decodeXmlText(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

export function readXmlTag(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return match?.[1] ? decodeXmlText(match[1].trim()) : undefined
}

export function parseTaskNotificationContent(
  content: unknown,
  timestamp?: string,
): SessionTaskNotification | null {
  const xml = extractTextBlocks(content)
    .map((text) => extractTaskNotificationXml(text))
    .find((value): value is string => value !== null)
  if (!xml) return null

  const toolUseId = readXmlTag(xml, 'tool-use-id')
  const status = readXmlTag(xml, 'status')
  if (
    !toolUseId ||
    (status !== 'completed' && status !== 'failed' && status !== 'stopped')
  ) {
    return null
  }

  const taskId = readXmlTag(xml, 'task-id') || toolUseId
  const summary = readXmlTag(xml, 'summary')
  const result = readXmlTag(xml, 'result')
  const outputFile = readXmlTag(xml, 'output-file')
  return {
    taskId,
    toolUseId,
    status,
    ...(summary ? { summary } : {}),
    ...(result ? { result } : {}),
    ...(outputFile ? { outputFile } : {}),
    ...(timestamp ? { timestamp } : {}),
  }
}

export function parsePersistedTaskNotification(
  value: unknown,
  timestamp?: string,
): SessionTaskNotification | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const notification = value as Record<string, unknown>
  const toolUseId = typeof notification.toolUseId === 'string'
    ? notification.toolUseId
    : null
  const status = notification.status
  if (
    !toolUseId ||
    (status !== 'completed' && status !== 'failed' && status !== 'stopped')
  ) {
    return null
  }

  const optionalString = (key: string) =>
    typeof notification[key] === 'string' && notification[key]
      ? notification[key] as string
      : undefined
  return {
    taskId: optionalString('taskId') ?? toolUseId,
    toolUseId,
    status,
    ...(optionalString('summary') ? { summary: optionalString('summary') } : {}),
    ...(optionalString('result') ? { result: optionalString('result') } : {}),
    ...(optionalString('outputFile') ? { outputFile: optionalString('outputFile') } : {}),
    ...(timestamp ? { timestamp } : {}),
  }
}
