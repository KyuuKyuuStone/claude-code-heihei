/**
 * local-command 解析族（v1.7 结构拆分 · ws/handler.ts 第②批 · 纯移动 · 绿灯区）。
 *
 * 从 src/server/ws/handler.ts 原样搬出的完整解析簇（原 :2679-2932，15 个绑定）：
 *   getDesktopSlashCommand / getTitleInputForUserMessage
 *   → createCurrentTurnLocalCommandForwarder（本族唯一的 exported 成员，见下）
 *   → isMatchingCurrentTurnLocalCommand / isLocalCommandOutputMessage
 *   → extractLocalCommandOutput / isCompactLocalCommandOutput / extractTaggedContent
 *   → extractLocalCommand / GoalEventData(type) / extractGoalEvent / looksLikeGoalCommandOutput
 *   → getCompactBoundaryMessage / isCompactSummaryMessageContent / hasToolResultBlock
 *   → extractReplayUserText
 *
 * 【exported 成员的处置 —— 搬走 + 门面 re-export 保 API】
 * `createCurrentTurnLocalCommandForwarder` 被 src/server/__tests__/ws-memory-events.test.ts
 * (:3 import / :583 / :625 调用) 直接引用，是**对外公开 API**。若留在门面，它要调
 * 本族 4 个已被搬走的函数，门面仍得 import 回来，白留一段族内逻辑；故选择随批搬走，
 * 由门面以 `import { ... } from './localCommandParsing.js'` + `export { ... }` 保 API——
 * **测试文件的 import 路径与调用一处未改（消费方零改动）**，门面导出面逐项不变。
 *
 * 【三向检查 · 模块级可变状态】handler.ts 有 28 个模块级可变状态。本族**不含任何**
 * 模块级状态：15 个绑定中 14 个是纯函数/纯类型，唯一的状态形似物是
 * createCurrentTurnLocalCommandForwarder 内的 `let awaitingCurrentTurnLocalCommandOutput`
 * ——它是**每次调用新建的闭包局部变量**，不跨调用共享，非模块级。已由 check-h2.ts
 * 的 moduleStateTripleCheck 机械确认（顶层 let/var = 0，顶层 new Map/Set = 0）。
 *
 * 【同名参数遮蔽核对】本族**无默认值形参**（唯一默认值是 extractLocalCommandOutput 的
 * 解构默认 `options: {...} = {}`，非同名函数遮蔽形态）。paramShadowScan 确认为空。
 *
 * 【历史死委托扫描】15 名在 HEAD 中均为实体声明，非转发。
 *
 * 搬移规则：函数体逐字不变（原就是模块级顶层、0 缩进、裸名互调），**零 this. 改写、
 * 零缩进调整**，仅对 exported 成员加 export 前缀（门面侧由 re-export 承接）。
 *
 * 路径依赖预检：无 import.meta / __dirname / __filename / process.execPath。
 */

import { parseSlashCommand } from '../../utils/slashCommandParsing.js'
import { stripRosterDigestSegment } from '../services/rosterDigest.js'
import {
  COMMAND_NAME_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from '../../constants/xml.js'
import {
  getCommandMetadataDisplayText,
  shouldHideCommandMetadataContent,
} from '../../utils/commandMetadata.js'

export function getDesktopSlashCommand(content: string): ReturnType<typeof parseSlashCommand> {
  const parsed = parseSlashCommand(content.trim())
  if (!parsed || parsed.isMcp) return null
  return parsed
}

export function getTitleInputForUserMessage(
  content: string,
  command: ReturnType<typeof parseSlashCommand>,
): string | null {
  if (command?.commandName !== 'goal') return content

  const args = command.args.trim()
  if (!args || args === 'clear') return null
  return args
}

export function createCurrentTurnLocalCommandForwarder(
  command: ReturnType<typeof parseSlashCommand>,
): (cliMsg: any) => boolean {
  let awaitingCurrentTurnLocalCommandOutput = false

  return (cliMsg: any) => {
    if (command && isMatchingCurrentTurnLocalCommand(cliMsg, command)) {
      awaitingCurrentTurnLocalCommandOutput = true
      return true
    }
    if (command?.commandName === 'goal' && isLocalCommandOutputMessage(cliMsg)) {
      const output = extractLocalCommandOutput(
        cliMsg.content ?? cliMsg.message,
        { allowUntagged: cliMsg.subtype === 'local_command_output' },
      )
      if (output && looksLikeGoalCommandOutput(output)) {
        awaitingCurrentTurnLocalCommandOutput = false
        return true
      }
    }
    if (
      awaitingCurrentTurnLocalCommandOutput &&
      isLocalCommandOutputMessage(cliMsg)
    ) {
      awaitingCurrentTurnLocalCommandOutput = false
      return true
    }
    return false
  }
}

function isMatchingCurrentTurnLocalCommand(
  cliMsg: any,
  command: NonNullable<ReturnType<typeof parseSlashCommand>>,
): boolean {
  if (cliMsg?.type !== 'system' || cliMsg?.subtype !== 'local_command') {
    return false
  }
  const localCommand = extractLocalCommand(cliMsg.content ?? cliMsg.message)
  if (!localCommand) return false
  return (
    localCommand.name === command.commandName &&
    localCommand.args.trim() === command.args.trim()
  )
}

function isLocalCommandOutputMessage(cliMsg: any): boolean {
  if (
    cliMsg?.type !== 'system' ||
    (cliMsg?.subtype !== 'local_command' &&
      cliMsg?.subtype !== 'local_command_output')
  ) {
    return false
  }
  return extractLocalCommandOutput(
    cliMsg.content ?? cliMsg.message,
    { allowUntagged: cliMsg.subtype === 'local_command_output' },
  ) !== null
}

export function extractLocalCommandOutput(
  content: unknown,
  options: { allowUntagged?: boolean } = {},
): string | null {
  const raw = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
        .flatMap((block) => {
          if (!block || typeof block !== 'object') return []
          const text = (block as { text?: unknown }).text
          return typeof text === 'string' ? [text] : []
        })
        .join('\n')
      : ''

  if (!raw) return null

  const stdout = extractTaggedContent(raw, LOCAL_COMMAND_STDOUT_TAG)
  if (stdout !== null) return stdout

  const stderr = extractTaggedContent(raw, LOCAL_COMMAND_STDERR_TAG)
  if (stderr !== null) return stderr

  if (options.allowUntagged) {
    const normalized = raw.trim()
    return normalized || null
  }

  return null
}

export function isCompactLocalCommandOutput(output: string): boolean {
  return output.trim() === 'Compacted'
}

function extractTaggedContent(raw: string, tag: string): string | null {
  const match = raw.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
  return match?.[1]?.trim() ?? null
}

export function extractLocalCommand(content: unknown): { name: string; args: string } | null {
  const raw = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
        .flatMap((block) => {
          if (!block || typeof block !== 'object') return []
          const text = (block as { text?: unknown }).text
          return typeof text === 'string' ? [text] : []
        })
        .join('\n')
      : ''

  const name = extractTaggedContent(raw, COMMAND_NAME_TAG)
  if (!name) return null
  return {
    name: name.replace(/^\//, ''),
    args: extractTaggedContent(raw, 'command-args') ?? '',
  }
}

type GoalEventData = {
  action: 'created' | 'replaced' | 'status' | 'paused' | 'resumed' | 'completed' | 'cleared' | 'message'
  status?: string
  objective?: string
  budget?: string
  elapsed?: string
  continuations?: string
  message?: string
}

export function extractGoalEvent(
  output: string,
  command?: { name: string; args: string },
): GoalEventData | null {
  if (command && command.name !== 'goal') return null

  const trimmed = output.trim()
  if (!trimmed) return null

  if (trimmed === 'Goal cleared.' || trimmed.startsWith('Goal cleared:')) {
    return { action: 'cleared', message: trimmed }
  }
  if (trimmed === 'Goal marked complete.') {
    return { action: 'completed', message: trimmed }
  }
  if (trimmed === 'No active goal.') {
    return { action: 'message', message: trimmed }
  }
  if (trimmed.startsWith('Goal continuing:')) {
    return {
      action: 'status',
      status: 'continuing',
      message: trimmed,
    }
  }

  if (trimmed.startsWith('Goal set:')) {
    const objective = trimmed.slice('Goal set:'.length).trim()
    return {
      action: 'created',
      status: 'active',
      objective: objective || undefined,
      message: trimmed,
    }
  }

  return command?.name === 'goal' ? { action: 'message', message: trimmed } : null
}

function looksLikeGoalCommandOutput(output: string): boolean {
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

export function getCompactBoundaryMessage(cliMsg: any): string {
  const message = typeof cliMsg?.message === 'string' ? cliMsg.message.trim() : ''
  if (message) return message

  const content = typeof cliMsg?.content === 'string' ? cliMsg.content.trim() : ''
  if (content) return content

  return 'Context compacted'
}

export function isCompactSummaryMessageContent(content: unknown): content is string {
  return (
    typeof content === 'string' &&
    content.trim().startsWith(
      'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.',
    )
  )
}

function hasToolResultBlock(content: unknown): boolean {
  return Array.isArray(content) &&
    content.some((block) =>
      Boolean(block) &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'tool_result')
}

export function extractReplayUserText(cliMsg: any): string | null {
  if (cliMsg?.isReplay !== true) return null
  const content = cliMsg.message?.content
  const commandDisplayText = getCommandMetadataDisplayText(content)
  if (commandDisplayText) return commandDisplayText
  if (shouldHideCommandMetadataContent(content)) return null
  if (isCompactSummaryMessageContent(content)) return null
  if (hasToolResultBlock(content)) return null
  if (extractLocalCommandOutput(content)) return null

  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
        .flatMap((block) => {
          if (!block || typeof block !== 'object') return []
          const typedBlock = block as { type?: unknown; text?: unknown }
          return typedBlock.type === 'text' && typeof typedBlock.text === 'string'
            ? [typedBlock.text]
            : []
        })
        .join('\n')
      : ''

  // v1.7.4 修缺陷：花名册摘要只是**给模型的系统段**，不得作为用户消息重放进 UI
  // （replay 文本取自 CLI 回显的原始正文，含前置系统段）⇒ 此处剥掉再 trim。
  const trimmed = stripRosterDigestSegment(text).trim()
  return trimmed || null
}
