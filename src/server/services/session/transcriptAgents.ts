/**
 * 转录中的 Agent 子链与 Goal 本地命令解析（v1.7 结构拆分 · sessionService
 * 第②批 · 纯移动）。
 *
 * 从 sessionService.ts 原样搬出的 9 个方法 + 2 个只被它们（及门面少量调用点）
 * 使用的类型。选段理由：与第①批同属转录解析域，且这 9 个方法**全部不读实例
 * 状态**——体内除组内互调外，只有一处对外部纯函数 readXmlTag 的调用；不含
 * 文件 IO、不含缓存、不含列表/索引。
 *
 * 搬移规则：函数体逐字不变，仅两处形式调整——
 *   ① 缩进 −2（原 class 方法体缩进 4，模块级函数体缩进 2）；
 *   ② 调用还原为裸调用：组内互调 this.foo( → foo(；第①批已搬走的
 *      this.readXmlTag( → readXmlTag(（改为从 ./transcriptContent.js 直接 import，
 *      语义与门面的类字段委托等价）。
 * 门面里这 9 个方法的位置改为同名类字段委托，所有调用点的 `this.xxx(...)`
 * 文本一行未改。
 *
 * 伴随搬移的两个类型（原为门面本地未导出类型，搬走后门面以 import type 引用，
 * 门面导出面不变）：
 *   · RawEntry    —— 9 个方法中 2 个的必需参数类型，被门面 35 处使用；
 *   · ContentBlock —— 3 个方法的必需类型，门面另有 1 处组外使用。
 *
 * 路径依赖预检：本段无 import.meta / __dirname / process.execPath（全文预检亦为零）。
 *
 * 有意未随本批搬走（留在门面）：
 *   · subagentTranscriptPath / loadSubagentToolMessages / appendSubagentToolMessages
 *     / resolveParentToolUseId —— 前者的 subagentTranscriptPath 依赖实例方法
 *     this.getProjectsDir()，其余三个是 async 文件 IO 并依赖上面的路径解析，
 *     属「含 this 且无法不改签名消除」，按补充裁决五一律不搬。
 */

import { readXmlTag } from './transcriptContent.js'
import type { PersistedWorktreeSession } from '../localIndex/types.js'
import type { MessageEntry } from '../sessionService.js'

/** Raw entry parsed from a single JSONL line */
export type RawEntry = {
  type?: string
  subtype?: string
  content?: unknown
  uuid?: string
  messageId?: string
  parentUuid?: string | null
  parent_tool_use_id?: string | null
  isSidechain?: boolean
  isMeta?: boolean
  cwd?: string
  message?: {
    role?: string
    content?: unknown
    model?: string
    id?: string
    type?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
      server_tool_use?: {
        web_search_requests?: number
      }
      speed?: string
    }
  }
  timestamp?: string
  version?: string
  snapshot?: {
    messageId?: string
    trackedFileBackups?: Record<string, unknown>
    timestamp?: string
  }
  customTitle?: string
  permissionMode?: string
  worktreeSession?: PersistedWorktreeSession | null
  title?: string
  [key: string]: unknown
}

export type ContentBlock = Record<string, unknown>

export function isGoalLocalCommandOutput(output: string): boolean {
  const trimmed = output.trim()
  return (
    trimmed.startsWith('Goal set:') ||
    trimmed.startsWith('Goal continuing:') ||
    trimmed.startsWith('Goal cleared:') ||
    trimmed === 'Goal cleared.' ||
    trimmed === 'Goal marked complete.' ||
    trimmed === 'No active goal.'
  )
}

export function isGoalLocalCommandEntry(entry: RawEntry): boolean {
  if (
    entry.type !== 'system' ||
    entry.subtype !== 'local_command' ||
    typeof entry.content !== 'string'
  ) {
    return false
  }

  const commandName = readXmlTag(entry.content, 'command-name')?.replace(/^\//, '')
  if (commandName) return commandName === 'goal'

  const output =
    readXmlTag(entry.content, 'local-command-stdout') ??
    readXmlTag(entry.content, 'local-command-stderr')
  return output ? isGoalLocalCommandOutput(output) : false
}

export function goalLocalCommandEntryToMessage(entry: RawEntry): MessageEntry | null {
  if (!isGoalLocalCommandEntry(entry)) return null
  return {
    id: entry.uuid || crypto.randomUUID(),
    type: 'system',
    content: entry.content,
    timestamp: entry.timestamp || new Date().toISOString(),
    parentUuid: entry.parentUuid ?? undefined,
    isSidechain: entry.isSidechain,
  }
}

export function extractAgentToolUseId(entry: RawEntry): string | undefined {
  const content = entry.message?.content
  if (!Array.isArray(content)) return undefined

  for (const block of content as Array<Record<string, unknown>>) {
    if (
      block.type === 'tool_use' &&
      block.name === 'Agent' &&
      typeof block.id === 'string'
    ) {
      return block.id
    }
  }

  return undefined
}

export function extractAgentToolUseIdsFromMessage(message: MessageEntry): string[] {
  if (message.type !== 'tool_use' || !Array.isArray(message.content)) {
    return []
  }

  return (message.content as ContentBlock[])
    .filter((block) => block.type === 'tool_use' && block.name === 'Agent')
    .flatMap((block) => (typeof block.id === 'string' ? [block.id] : []))
}

export function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return (content as ContentBlock[])
    .flatMap((block) => (typeof block.text === 'string' ? [block.text] : []))
    .join('\n')
}

export function extractAgentIdFromResultText(text: string): string | undefined {
  const match = text.match(/(?:^|\n)\s*agentId:\s*([A-Za-z0-9_-]+)/)
  return match?.[1]
}

export function extractAgentResultLinks(messages: MessageEntry[]): Map<string, string> {
  const agentToolUseIds = new Set(
    messages.flatMap((message) => extractAgentToolUseIdsFromMessage(message)),
  )
  const resultLinks = new Map<string, string>()

  for (const message of messages) {
    if (message.type !== 'tool_result' || !Array.isArray(message.content)) {
      continue
    }

    for (const block of message.content as ContentBlock[]) {
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') {
        continue
      }
      if (!agentToolUseIds.has(block.tool_use_id)) {
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

  return resultLinks
}

export function namespaceSubagentContentIds(content: unknown, namespace: string): unknown {
  if (!Array.isArray(content)) return content

  return (content as ContentBlock[]).map((block) => {
    if (!block || typeof block !== 'object') return block
    if (block.type === 'tool_use' && typeof block.id === 'string') {
      return { ...block, id: `${namespace}/${block.id}` }
    }
    if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      return { ...block, tool_use_id: `${namespace}/${block.tool_use_id}` }
    }
    return block
  })
}
