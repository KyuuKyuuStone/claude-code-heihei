/**
 * extractSpeakableText —— 把消息正文转成「可朗读的文本段」（纯函数，可独立单测）。
 *
 * 朗读源与消息操作条的 copyText 同源（三个调用点传同一 content 字符串）。
 * 本模块**不做任何 i18n 依赖**（lib 层不得触 stores/i18n）：代码块的占位语由调用方
 * 经 `codeBlockPlaceholder` 传入。
 *
 * 规则（设计裁定 §3）：
 *   1) 围栏代码块（``` 或 ~~~）整块替换为一句占位语（每块一句）；
 *   2) 行内 `code` 去反引号留文字；图片语法整条剔除；链接 [t](u) → t；HTML 标签剥离；
 *   3) 去标题 #、列表符、引用 >、表格管道 |、加粗星号 *（**保留下划线**，避免破坏
 *      `foo_bar` 这类标识符）；
 *   4) 按句切段，单段 ≤ SPEECH_MAX_SEGMENT_CHARS；总长 ≤ SPEECH_MAX_TOTAL_CHARS，
 *      超出即截断并置 truncated；
 *   5) 提取结果为空（例如纯图消息）⇒ 调用方不渲染喇叭。
 */

/** 送进朗读队列的字符总上限（具名常量，便于后调）。 */
export const SPEECH_MAX_TOTAL_CHARS = 5000

/** 单段字符上限：过长的句子在部分平台的 TTS 上会静默中断，故按句再按长度切。 */
export const SPEECH_MAX_SEGMENT_CHARS = 200

export type SpeakableExtraction = {
  segments: string[]
  /** 是否因超长而截断（调用方据此给轻提示）。 */
  truncated: boolean
}

export type ExtractSpeakableTextOptions = {
  /** 代码块整块替换用的占位语（由调用方从 i18n 取）。 */
  codeBlockPlaceholder: string
}

/** 句末标点：中日韩标点可零空白分隔；ASCII 的 .!? 要求后随空白，避免切坏 3.14 / e.g.。 */
const SENTENCE_BOUNDARY_RE = /(?<=[。！？；;\n])\s*|(?<=[.!?])\s+/

/** 行首标记：标题 / 引用 / 列表符。 */
const LEADING_HEADING_RE = /^\s*#{1,6}\s*/
const LEADING_QUOTE_RE = /^\s*>\s?/
const LEADING_LIST_RE = /^\s*(?:[-*+]|\d+[.)])\s+/

/**
 * 围栏代码块整块替换：逐行扫描跟踪围栏状态。
 * 未闭合的围栏（消息被截断）同样整块吞掉——宁可少读，不把代码当散文念。
 */
function replaceFencedBlocks(input: string, placeholder: string): string {
  const out: string[] = []
  let inside = false
  for (const line of input.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      if (!inside) {
        inside = true
        out.push(placeholder)
      } else {
        inside = false
      }
      continue
    }
    if (inside) continue
    out.push(line)
  }
  return out.join('\n')
}

/** 行内 markdown 清理（顺序有意：图片先于链接，避免 ![a](u) 被链接规则吃掉半截）。 */
function stripInlineMarkdown(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // 图片语法整条剔除
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接 → 链接文字
    .replace(/`([^`]*)`/g, '$1') // 行内 code 去反引号
    .replace(/<[^>]*>/g, ' ') // HTML 标签
    .replace(LEADING_HEADING_RE, '')
    .replace(LEADING_QUOTE_RE, '')
    .replace(LEADING_LIST_RE, '')
    .replace(/\|/g, ' ') // 表格管道
    .replace(/\*\*/g, '') // 加粗
    .replace(/\*/g, '') // 斜体 / 残留星号
    .replace(/[ \t\u00a0]+/g, ' ')
    .trim()
}

/** 超长句再切：优先在逗号/顿号/空格处断开，否则硬切。 */
function splitLongSentence(sentence: string): string[] {
  if (sentence.length <= SPEECH_MAX_SEGMENT_CHARS) return [sentence]
  const out: string[] = []
  let rest = sentence
  while (rest.length > SPEECH_MAX_SEGMENT_CHARS) {
    const window = rest.slice(0, SPEECH_MAX_SEGMENT_CHARS)
    const breakAt = Math.max(
      window.lastIndexOf('，'),
      window.lastIndexOf(','),
      window.lastIndexOf('、'),
      window.lastIndexOf(' '),
    )
    const cut = breakAt > SPEECH_MAX_SEGMENT_CHARS / 2 ? breakAt + 1 : SPEECH_MAX_SEGMENT_CHARS
    const head = rest.slice(0, cut).trim()
    if (head) out.push(head)
    rest = rest.slice(cut)
  }
  const tail = rest.trim()
  if (tail) out.push(tail)
  return out
}

export function extractSpeakableText(
  raw: string,
  options: ExtractSpeakableTextOptions,
): SpeakableExtraction {
  if (!raw || raw.trim() === '') return { segments: [], truncated: false }

  const withoutFences = replaceFencedBlocks(raw, options.codeBlockPlaceholder)
  const flattened = withoutFences.split('\n').map(stripInlineMarkdown).join('\n')

  const sentences: string[] = []
  for (const piece of flattened.split(SENTENCE_BOUNDARY_RE)) {
    const text = piece?.trim() ?? ''
    if (!text) continue
    sentences.push(...splitLongSentence(text))
  }

  const segments: string[] = []
  let total = 0
  let truncated = false
  for (const sentence of sentences) {
    const remaining = SPEECH_MAX_TOTAL_CHARS - total
    if (remaining <= 0) {
      truncated = true
      break
    }
    if (sentence.length > remaining) {
      const head = sentence.slice(0, remaining).trim()
      if (head) segments.push(head)
      truncated = true
      break
    }
    segments.push(sentence)
    total += sentence.length
  }

  return { segments, truncated }
}
