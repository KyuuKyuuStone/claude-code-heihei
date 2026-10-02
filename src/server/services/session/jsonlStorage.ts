/**
 * JSONL 存储读写与 Agent 子链转录装载（v1.7 结构拆分 · sessionService 第⑥批 · 纯移动）。
 *
 * 从 sessionService.ts 原样搬出的 9 个实例方法，构成一条完整语义链：
 *   路径基础（getConfigDir / getProjectsDir / sanitizePath）
 *   → JSONL 读写（readJsonlFile / streamJsonlFile / appendJsonlEntry）
 *   → Agent 子链（subagentTranscriptPath / loadSubagentToolMessages / appendSubagentToolMessages）
 * 九者体内**均无 this.<字段>**，跨组依赖全部指向已搬模块的同名函数
 * （entryToMessage←第⑤批、shouldHideTranscriptEntry←第④批、
 *   namespaceSubagentContentIds/extractAgentResultLinks←第②批）与外部工具。
 *
 * 搬移规则：函数体逐字不变，仅两处形式调整——
 *   ① 缩进 −2（原 class 方法体缩进 4，模块级函数体缩进 2）；
 *   ② 组内与跨模块互调 this.foo( → foo(。
 * 门面里除 loadSubagentToolMessages 外的 8 个方法改为同名类字段委托，**门面调用点
 * （共 51 处）的 `this.xxx(...)` 文本一行未改**。
 *
 * loadSubagentToolMessages 的特殊处理：它唯一的调用点在 appendSubagentToolMessages
 * 内部（已随本批搬走），门面已无组外调用点，按第⑤批 resolveParentToolUseId 先例
 * **不留死委托**，直接由新模块内部裸调用。
 *
 * 连带清理（双向对应检查抓到的历史残留）：第②批在门面留下的
 *   private extractAgentResultLinks = extractAgentResultLinks
 *   private namespaceSubagentContentIds = namespaceSubagentContentIds
 * 其唯一调用点分别是 appendSubagentToolMessages / loadSubagentToolMessages，两者
 * 本批搬走 → 这两个委托将无任何组外调用点、成为**死委托**，故一并删除；随之
 * 门面 import 里的对应两个名字亦不再有使用者，同步移除（否则触发 unused-import 门禁）。
 *
 * 未随本批搬走的相邻项（有意保留在门面）：
 *   · scanTailWindow / computeSemanticTailModifiedAt / readTailModifiedAt：列表摘要与
 *     尾部扫描路径，红灯区（列表/缓存）；且 createReadStream 在门面仍有使用者。
 *   · readTargetedJsonlEntries / readJsonlFileWindow / accumulateUsageFromLine：碰实例状态
 *     （this.localIndexGateway）或属窗口读取路径，红灯区。
 *   · isValidSessionId / formatCost / appendSessionMetadata：纯工具但语义上归属
 *     会话元数据事务，与 JSONL 读写链不同族，留作后续批次。
 *
 * 三向检查（模块级可变状态）：本批**不含任何模块级可变状态**，9 个函数全为纯函数
 * （仅依赖入参与外部 import），不适用、自然满足。
 *
 * 路径依赖预检：本段无 import.meta / __dirname / __filename / process.execPath。
 */

import * as fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import * as path from 'node:path'
import { sanitizePath as sanitizePortablePath } from '../../../utils/sessionStoragePortable.js'
import { getClaudeConfigHomeDir } from '../../../utils/envUtils.js'
import type { MessageEntry } from '../sessionService.js'
import {
  extractAgentResultLinks,
  namespaceSubagentContentIds,
} from './transcriptAgents.js'
import { shouldHideTranscriptEntry } from './transcriptEntries.js'
import { entryToMessage } from './messageConversion.js'
import type { RawEntry } from './transcriptAgents.js'

export function getConfigDir(): string {
  return path.resolve(getClaudeConfigHomeDir())
}

export function getProjectsDir(): string {
  return path.join(getConfigDir(), 'projects')
}

/**
 * Sanitize a path the same way the shared session storage does.
 * This must remain Windows-safe, so reserved characters such as ':' are normalized too.
 */
export function sanitizePath(dirPath: string): string {
  return sanitizePortablePath(dirPath)
}

export async function readJsonlFile(filePath: string): Promise<RawEntry[]> {
  let content: string
  try {
    content = await fs.readFile(filePath, 'utf-8')
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw err
  }

  const entries: RawEntry[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      entries.push(JSON.parse(trimmed) as RawEntry)
    } catch {
      // skip malformed lines
    }
  }
  return entries
}

export async function streamJsonlFile(
  filePath: string,
  onEntry: (entry: RawEntry) => void,
): Promise<void> {
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const lines = createInterface({
    input: stream,
    crlfDelay: Infinity,
  })

  try {
    for await (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        onEntry(JSON.parse(trimmed) as RawEntry)
      } catch {
        // skip malformed lines
      }
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err
    }
  } finally {
    lines.close()
    stream.destroy()
  }
}

export async function appendJsonlEntry(filePath: string, entry: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify(entry) + '\n'
  await fs.appendFile(filePath, line, 'utf-8')
}

export function subagentTranscriptPath(
  projectDir: string,
  sessionId: string,
  agentId: string,
): string {
  const normalizedAgentId = agentId.startsWith('agent-') ? agentId : `agent-${agentId}`
  return path.join(
    getProjectsDir(),
    projectDir,
    sessionId,
    'subagents',
    `${normalizedAgentId}.jsonl`,
  )
}

export async function loadSubagentToolMessages(
  projectDir: string,
  sessionId: string,
  parentToolUseId: string,
  agentId: string,
): Promise<MessageEntry[]> {
  const filePath = subagentTranscriptPath(projectDir, sessionId, agentId)
  const entries = await readJsonlFile(filePath)
  const namespace = `${parentToolUseId}/${agentId}`
  const messages: MessageEntry[] = []

  for (const entry of entries) {
    if (!entry.message?.role || entry.isMeta) continue
    if (shouldHideTranscriptEntry(entry)) continue
    if (entry.type !== 'user' && entry.type !== 'assistant' && entry.type !== 'system') {
      continue
    }

    const message = entryToMessage(
      {
        ...entry,
        message: {
          ...entry.message,
          content: namespaceSubagentContentIds(entry.message.content, namespace),
        },
      },
      parentToolUseId,
    )
    if (message && (message.type === 'tool_use' || message.type === 'tool_result')) {
      messages.push(message)
    }
  }

  return messages
}

export async function appendSubagentToolMessages(
  projectDir: string,
  sessionId: string,
  messages: MessageEntry[],
): Promise<MessageEntry[]> {
  const resultLinks = extractAgentResultLinks(messages)
  if (resultLinks.size === 0) {
    return messages
  }

  const childMessages = await Promise.all(
    [...resultLinks.entries()].map(([parentToolUseId, agentId]) =>
      loadSubagentToolMessages(projectDir, sessionId, parentToolUseId, agentId),
    ),
  )
  return [...messages, ...childMessages.flat()]
}
