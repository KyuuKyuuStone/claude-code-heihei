/**
 * SessionShedService — R-A「修复会话」：剥离超大载荷，让被 413 卡死的会话重新可用
 *
 * 背景（v1.7.5 413 专项）：员工会话一旦把请求体顶到链路上限，之后**每个回合**
 * 都会以确定性失败（413 / request_too_large）结束——自动续跑/重推再积极也救不回来
 * （请求内容没变）。这一批给出的恢复手段就是本服务：把 transcript 里的大块载荷
 * （媒体块 + 超大文本块）**原位替换成占位引用**，内容落盘可查。
 *
 * 设计约束（架构师口径）：
 * - **非破坏性**：不改消息 `uuid` / `parentUuid`、**不删行**——只在块的位置替换内容，
 *   所以 `--resume` / rewind / 会话树/ uuid 链完全兼容；`file-history-snapshot` 等
 *   非消息行原样保留（整行重写骨架复用 `transcriptDerivation.trimSessionMessagesFrom`
 *   的「读全部行 → 过滤 → 整体写回」形态，但本处是**逐行原位改**，比过滤更保守）。
 * - **先备份后改**：改前把原 jsonl 逐字节复制到 `<sessionId>.jsonl.shed-<ts>.bak`，
 *   路径如实返回；备份失败 ⇒ 中止（绝不带风险改盘）。
 * - **不动台账**：本服务不碰 `collabTaskService`（任务状态与"会话被修好"是两件事）。
 *
 * ⚠ **进程内历史**（架构设计未显式覆盖，本批补上）：
 * 光改磁盘**不够**——活着的 CLI 进程仍持有内存里的大消息，照样每回合发超限请求。
 * 本实现的路径是 **(a) 停该会话进程**：改盘后调用 `conversationService.stopSessionAndWait`，
 * 让内存态整体丢弃；下次投递/发消息时由**既有** `sessionMessenger.deliver → startSession`
 * （未运行则自动拉起）机制重新加载——它读的就是刚改好的 transcript。
 * 为什么不选 (b) 让 CLI 自体重载：CLI 侧没有 transcript 热重载入口，要新增一条跨进程
 * 控制指令 + 在 CLI 内重建内存会话态，风险远高于"停+按既有机制重启"，而后者复用的
 * 是既有一等路径（裁决二十一④：deliver 本就会自动拉起未加载会话）。
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { ApiError } from '../middleware/errorHandler.js'
import { sessionService } from './sessionService.js'
import { conversationService } from './conversationService.js'
import { unlockSessionPayload } from './servantOversizeFailure.js'

/** 单块文本超过该字节数即视为「超大文本块」并截断（保留头部 + 落盘引用） */
export const TEXT_SHED_THRESHOLD_BYTES = 32 * 1024
/** 截断后原位保留的头部字节数（让人/模型还能看出这段原本在说什么） */
export const TEXT_SHED_HEAD_KEEP_BYTES = 2 * 1024
/** 落盘目录（相对会话工作目录；解析不到工作目录时退回 transcript 同目录） */
export const SHED_SPILL_DIR = '.heihei/shed'

export type ShedPayloadResult = {
  ok: true
  sessionId: string
  bytesBefore: number
  bytesAfter: number
  mediaBlocksRemoved: number
  textBlocksTruncated: number
  messagesTouched: number
  backupPath: string
  spillPath: string | null
  stoppedProcess: boolean
}

export type ShedDeps = {
  findSessionFile: (sessionId: string) => Promise<{ filePath: string; projectDir: string } | null>
  getSessionWorkDir: (sessionId: string) => Promise<string | null>
  /** 会话进程是否活着（决定是否需要停进程 + 是否会在报告里如实说"停了"） */
  isSessionRunning: (sessionId: string) => boolean
  stopSessionAndWait: (sessionId: string) => Promise<void>
  now: () => number
}

const defaultDeps: ShedDeps = {
  findSessionFile: (sessionId) => sessionService.findSessionFile(sessionId),
  getSessionWorkDir: (sessionId) => sessionService.getSessionWorkDir(sessionId),
  isSessionRunning: (sessionId) => conversationService.hasSession(sessionId),
  stopSessionAndWait: (sessionId) => conversationService.stopSessionAndWait(sessionId),
  now: () => Date.now(),
}

let deps: ShedDeps = defaultDeps

/** 测试注入：局部覆盖（传 null 复位） */
export function setShedDepsForTests(next: Partial<ShedDeps> | null): void {
  deps = next ? { ...deps, ...next } : defaultDeps
}

type ShedBlockRecord = {
  messageUuid: string
  where: string
  kind: 'image' | 'document' | 'text' | 'tool_result_text'
  bytes: number
  content: unknown
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** 截断到不超过 maxBytes，且不切坏多字节字符（按字符回退） */
function truncateToUtf8Bytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text
  let end = Math.min(text.length, maxBytes)
  while (end > 0 && byteLength(text.slice(0, end)) > maxBytes) end -= 1
  return text.slice(0, end)
}

function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/**
 * 遍历一条消息的 content，把大块换成占位引用（返回是否有改动）。
 * 覆盖：image / document 块、tool_result 内嵌的 image/text（数组或字符串形态）、
 * 超过阈值的 text 块。**不动** uuid / role / 其它字段。
 */
function shedContentBlocks(
  content: unknown,
  messageUuid: string,
  record: (item: ShedBlockRecord) => string,
  counters: { media: number; text: number },
): boolean {
  if (!Array.isArray(content)) {
    // 少见形态：整段 content 是字符串（旧格式）——同样按超大文本处理
    if (typeof content === 'string' && byteLength(content) > TEXT_SHED_THRESHOLD_BYTES) {
      // 由调用方替换（这里无法原位改字符串容器），交给 caller 处理
      return false
    }
    return false
  }
  let changed = false
  for (let i = 0; i < content.length; i += 1) {
    const block = content[i] as Record<string, unknown> | null
    if (!block || typeof block !== 'object') continue
    const type = block.type

    if (type === 'image' || type === 'document') {
      const bytes = byteLength(JSON.stringify(block))
      const ref = record({
        messageUuid,
        where: `content[${i}]`,
        kind: type,
        bytes,
        content: block,
      })
      content[i] = {
        type: 'text',
        text: `[已剥离：${type === 'image' ? '图片' : '文档'}块 · ${humanBytes(bytes)} → 引用 ${ref}]`,
      }
      counters.media += 1
      changed = true
      continue
    }

    if (type === 'text' && typeof block.text === 'string' && byteLength(block.text) > TEXT_SHED_THRESHOLD_BYTES) {
      const bytes = byteLength(block.text)
      const ref = record({
        messageUuid,
        where: `content[${i}]`,
        kind: 'text',
        bytes,
        content: block.text,
      })
      const head = truncateToUtf8Bytes(block.text, TEXT_SHED_HEAD_KEEP_BYTES)
      content[i] = {
        ...block,
        text: `${head}\n\n[已剥离：超大文本块 · ${humanBytes(bytes)}（保留前 ${humanBytes(TEXT_SHED_HEAD_KEEP_BYTES)}）→ 引用 ${ref}]`,
      }
      counters.text += 1
      changed = true
      continue
    }

    if (type === 'tool_result') {
      const inner = block.content
      if (Array.isArray(inner)) {
        const innerChanged = shedContentBlocks(inner, messageUuid, record, counters)
        if (innerChanged) changed = true
        continue
      }
      if (typeof inner === 'string' && byteLength(inner) > TEXT_SHED_THRESHOLD_BYTES) {
        const bytes = byteLength(inner)
        const ref = record({
          messageUuid,
          where: `content[${i}].tool_result`,
          kind: 'tool_result_text',
          bytes,
          content: inner,
        })
        const head = truncateToUtf8Bytes(inner, TEXT_SHED_HEAD_KEEP_BYTES)
        content[i] = {
          ...block,
          content: `${head}\n\n[已剥离：工具输出过大 · ${humanBytes(bytes)}（保留前 ${humanBytes(TEXT_SHED_HEAD_KEEP_BYTES)}）→ 引用 ${ref}]`,
        }
        counters.text += 1
        changed = true
      }
    }
  }
  return changed
}

/**
 * 备用文件名：`.jsonl` 之外的后缀，确保不被会话文件扫描器当成会话 read。
 *
 * J3a（返工）：除时间戳外再加一段随机 token —— 同一毫秒内并发两次修复（两台
 * 桌面端/两个请求）时，只有时间戳会让 backupPath 与 spillPath 相撞，后写覆盖
 * 前写、先写那份的占位引用可能悬空。token 只用于唯一性，不参与诊断口径。
 */
function uniqueToken(): string {
  return crypto.randomBytes(4).toString('hex')
}
function backupPathFor(filePath: string, stamp: number, token: string): string {
  return `${filePath}.shed-${stamp}-${token}.bak`
}

/**
 * 执行一次「修复会话」。幂等语义：无可剥离内容 ⇒ 抛 409 NOTHING_TO_SHED（不写盘、不备份）。
 */
export async function shedSessionPayload(sessionId: string): Promise<ShedPayloadResult> {
  if (!sessionId || !sessionId.trim()) {
    throw ApiError.badRequest('Field "sessionId" is required')
  }
  const found = await deps.findSessionFile(sessionId)
  if (!found) throw ApiError.notFound(`Session not found: ${sessionId}`)

  const raw = await fs.readFile(found.filePath, 'utf8')
  const bytesBefore = byteLength(raw)
  const hadTrailingNewline = raw.endsWith('\n')
  const lines = raw.split('\n')
  if (hadTrailingNewline) lines.pop() // 末尾空段不算行

  // spill 位置先算好（记录器要把「文件 + 行号」写进占位引用，才叫"引用可查"）
  const stamp = deps.now()
  const workDir = await deps.getSessionWorkDir(sessionId).catch(() => null)
  const spillDir = workDir
    ? path.join(workDir, SHED_SPILL_DIR)
    : path.join(path.dirname(found.filePath), 'shed')
  const token = uniqueToken()
  const spillPath = path.join(spillDir, `${sessionId}-${stamp}-${token}.jsonl`)
  const spillLabel = workDir ? `${SHED_SPILL_DIR}/${path.basename(spillPath)}` : spillPath

  const spillRecords: Array<ShedBlockRecord & { ref: string }> = []
  const counters = { media: 0, text: 0 }
  let messagesTouched = 0

  const record = (item: ShedBlockRecord): string => {
    const ref = `${spillLabel}#${spillRecords.length + 1}`
    spillRecords.push({ ...item, ref })
    return ref
  }

  const outLines = lines.map((line) => {
    if (!line.trim()) return line
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      return line // 坏行原样保留（绝不因修复动作丢数据）
    }
    const message = entry.message as Record<string, unknown> | undefined
    if (!message || typeof message !== 'object') return line
    const before = { media: counters.media, text: counters.text }
    const changed = shedContentBlocks(
      message.content,
      typeof entry.uuid === 'string' ? entry.uuid : 'unknown',
      record,
      counters,
    )
    const alsoString =
      typeof message.content === 'string' && byteLength(message.content) > TEXT_SHED_THRESHOLD_BYTES
    if (!changed && !alsoString) return line
    if (alsoString && typeof message.content === 'string') {
      const bytes = byteLength(message.content)
      const ref = record({
        messageUuid: typeof entry.uuid === 'string' ? entry.uuid : 'unknown',
        where: 'content',
        kind: 'text',
        bytes,
        content: message.content,
      })
      message.content = `${truncateToUtf8Bytes(message.content, TEXT_SHED_HEAD_KEEP_BYTES)}\n\n[已剥离：超大文本块 · ${humanBytes(bytes)}（保留前 ${humanBytes(TEXT_SHED_HEAD_KEEP_BYTES)}）→ 引用 ${ref}]`
      counters.text += 1
    }
    if (counters.media === before.media && counters.text === before.text) return line
    messagesTouched += 1
    return JSON.stringify(entry)
  })

  if (messagesTouched === 0) {
    throw new ApiError(
      409,
      'NOTHING_TO_SHED: no media blocks or oversized text blocks found in this session transcript',
      'NOTHING_TO_SHED',
    )
  }

  // ── 落盘被剥离的内容（一行一块，占位引用里带「文件#行号」，可查）─────────
  if (spillRecords.length > 0) {
    await fs.mkdir(spillDir, { recursive: true })
    const body =
      spillRecords
        .map((item) =>
          JSON.stringify({
            ref: item.ref,
            sessionId,
            messageUuid: item.messageUuid,
            where: item.where,
            kind: item.kind,
            bytes: item.bytes,
            content: item.content,
          }),
        )
        .join('\n') + '\n'
    await fs.writeFile(spillPath, body, 'utf8')
  }

  // ── 备份（失败即中止，绝不带风险改盘）──────────────────────────────────
  const backupPath = backupPathFor(found.filePath, stamp, token)
  try {
    await fs.copyFile(found.filePath, backupPath)
  } catch (error) {
    throw new ApiError(
      500,
      `Backup failed, transcript left untouched: ${error instanceof Error ? error.message : String(error)}`,
      'BACKUP_FAILED',
    )
  }

  const nextContent = outLines.join('\n') + (hadTrailingNewline ? '\n' : '')
  const bytesAfter = byteLength(nextContent)
  const tmp = `${found.filePath}.shed.tmp`
  await fs.writeFile(tmp, nextContent, 'utf8')
  await fs.rename(tmp, found.filePath)

  // ── 进程内历史：停进程，交由既有 deliver→startSession 机制在下次投递时重载 ──
  let stoppedProcess = false
  if (deps.isSessionRunning(sessionId)) {
    await deps.stopSessionAndWait(sessionId)
    stoppedProcess = true
  }

  // ── 修复成功 ⇒ 解锁 + 连续计数归零（R-C）────────────────────────────────
  unlockSessionPayload(sessionId)

  return {
    ok: true,
    sessionId,
    bytesBefore,
    bytesAfter,
    mediaBlocksRemoved: counters.media,
    textBlocksTruncated: counters.text,
    messagesTouched,
    backupPath,
    spillPath,
    stoppedProcess,
  }
}
