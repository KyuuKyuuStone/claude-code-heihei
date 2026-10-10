/**
 * mediaBudget —— 请求内媒体块的**字节预算**（v1.7.5 P-A）
 *
 * 由来：`stripExcessMediaItems` 原本只用 `API_MAX_MEDIA_PER_REQUEST`(100) 封
 * **条数**、不封**字节** ⇒ 100 张 5MB 图片（≈33MB base64）能撑爆 32MB 请求体
 * 而完全不触发条数上限。本模块把它改为**字节感知**：媒体总字节超预算时，
 * 按**从最旧开始**（延续原策略：宁可丢旧图也要让会话继续）丢弃，直到条数与
 * 字节**同时**达标。
 *
 * 调用点：`claude.ts` 在请求定形后、发送前调用（原 `:1438` 处）。
 * 纯函数、不改入参消息对象（返回新数组/新对象）。
 *
 * 注意：本文件**刻意不从 `src/types/message.js` 导入命名类型**——那是自动生成的
 * stub（不导出这些名字），全仓靠 tsc 棘轮基线兜住；新文件引入会新增棘轮签名
 * （只紧不松）。改用最小结构视图，运行时等价。
 */

type BlockLike = {
  type?: string
  content?: unknown
  source?: { data?: unknown }
}
type MessageLike = { message?: { content?: unknown } }

/** base64 `data` 之外的块信封开销（type/source/media_type 等字段）估算值 */
const MEDIA_BLOCK_ENVELOPE_BYTES = 80

/** 该块是否为媒体（image / document） */
function isMediaBlock(block: unknown): boolean {
  const t = (block as { type?: string } | null)?.type
  return t === 'image' || t === 'document'
}

function isToolResultBlock(block: unknown): boolean {
  return (block as { type?: string } | null)?.type === 'tool_result'
}

/** 单个媒体块的字节成本估算（base64 长度 + 信封；base64 无转义，误差可忽略） */
function mediaBlockBytes(block: BlockLike): number {
  const data = block.source?.data
  const len = typeof data === 'string' ? Buffer.byteLength(data, 'utf-8') : 0
  return len + MEDIA_BLOCK_ENVELOPE_BYTES
}

/** 媒体出现位置（按消息顺序 = 时间顺序；`nested` 非 null 表示在 tool_result 内嵌） */
type MediaSlot = {
  key: string
  msgIndex: number
  blockIndex: number
  nestedIndex: number | null
  bytes: number
}

function collectMediaSlots(messages: readonly MessageLike[]): MediaSlot[] {
  const slots: MediaSlot[] = []
  messages.forEach((message, msgIndex) => {
    const content = message?.message?.content
    if (!Array.isArray(content)) return
    content.forEach((block, blockIndex) => {
      const b = block as BlockLike
      if (isMediaBlock(b)) {
        slots.push({
          key: `${msgIndex}:${blockIndex}:-`,
          msgIndex,
          blockIndex,
          nestedIndex: null,
          bytes: mediaBlockBytes(b),
        })
      }
      if (isToolResultBlock(b) && Array.isArray(b.content)) {
        ;(b.content as BlockLike[]).forEach((nested, nestedIndex) => {
          if (isMediaBlock(nested)) {
            slots.push({
              key: `${msgIndex}:${blockIndex}:${nestedIndex}`,
              msgIndex,
              blockIndex,
              nestedIndex,
              bytes: mediaBlockBytes(nested),
            })
          }
        })
      }
    })
  })
  return slots
}

/** 按 slot key 集合重建消息数组（只重建受影响的消息；无改动则原样返回） */
function applyMediaRemovals(
  messages: readonly MessageLike[],
  drop: ReadonlySet<string>,
): MessageLike[] {
  const byMessage = new Map<number, Set<string>>()
  for (const key of drop) {
    const msgIndex = Number.parseInt(key.split(':')[0]!, 10)
    const set = byMessage.get(msgIndex)
    if (set) set.add(key)
    else byMessage.set(msgIndex, new Set([key]))
  }
  if (byMessage.size === 0) return messages as MessageLike[]

  return messages.map((message, msgIndex) => {
    const dropped = byMessage.get(msgIndex)
    if (!dropped) return message
    const content = message?.message?.content
    if (!Array.isArray(content)) return message

    const nextContent = (content as BlockLike[])
      .map((block, blockIndex) => {
        if (dropped.has(`${msgIndex}:${blockIndex}:-`)) return null // 顶层媒体：整块丢
        if (!isToolResultBlock(block) || !Array.isArray(block.content)) return block
        const nested = (block.content as BlockLike[]).filter(
          (_nested, nestedIndex) =>
            !dropped.has(`${msgIndex}:${blockIndex}:${nestedIndex}`),
        )
        return nested.length === (block.content as BlockLike[]).length
          ? block
          : { ...block, content: nested }
      })
      .filter((block): block is BlockLike => block !== null)

    return {
      ...message,
      message: {
        ...message.message,
        // 消息不能变成空 content（API 会拒），且必须保住消息本身（否则可能拆散
        // tool_use/tool_result 配对）⇒ 全被剥时留一条可读标记
        content:
          nextContent.length === 0
            ? [{ type: 'text', text: '[media removed]' }]
            : nextContent,
      },
    }
  })
}

/**
 * 媒体条数 + 字节双上限裁剪。`mediaByteBudget` 省略时只按条数（旧行为）。
 * 丢弃顺序：**最旧优先**（与既有策略一致）。
 */
export function stripExcessMediaItems<T extends MessageLike>(
  messages: T[],
  limit: number,
  mediaByteBudget: number = Number.POSITIVE_INFINITY,
): T[] {
  const slots = collectMediaSlots(messages)
  if (slots.length === 0) return messages

  const totalBytes = slots.reduce((sum, slot) => sum + slot.bytes, 0)
  let overCount = slots.length - limit
  let overBytes = totalBytes - mediaByteBudget
  if (overCount <= 0 && overBytes <= 0) return messages

  const drop = new Set<string>()
  for (const slot of slots) {
    if (overCount <= 0 && overBytes <= 0) break
    drop.add(slot.key)
    overCount--
    overBytes -= slot.bytes
  }

  return applyMediaRemovals(messages, drop) as T[]
}

/** 统计媒体总字节（诊断用；与裁剪同口径） */
export function totalMediaBytes(messages: readonly MessageLike[]): number {
  return collectMediaSlots(messages).reduce((sum, slot) => sum + slot.bytes, 0)
}
