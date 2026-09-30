import { memo, useEffect, useRef, useState, type ComponentType, type CSSProperties } from 'react'
import { Highlight, type PrismTheme } from 'prism-react-renderer'
import { CopyButton } from '@/components/ui/CopyButton'
import { useTranslation } from '../../i18n'

type Props = {
  code: string
  language?: string
  maxLines?: number
  showLineNumbers?: boolean
  wrapLongLines?: boolean
  /** 流式增长（只增不改）时启用分段高亮：封顶段走 memo 零重算，每帧只重高亮尾部 */
  streaming?: boolean
}

const warmPrismTheme: PrismTheme = {
  plain: {
    color: 'var(--color-code-fg)',
    backgroundColor: 'transparent',
  },
  styles: [
    { types: ['comment', 'prolog', 'doctype', 'cdata'], style: { color: 'var(--color-code-comment)', fontStyle: 'italic' as const } },
    { types: ['string', 'attr-value', 'template-string'], style: { color: 'var(--color-code-string)' } },
    { types: ['keyword', 'selector', 'important', 'atrule'], style: { color: 'var(--color-code-keyword)' } },
    { types: ['function'], style: { color: 'var(--color-code-function)' } },
    { types: ['tag'], style: { color: 'var(--color-code-keyword)' } },
    { types: ['number', 'boolean'], style: { color: 'var(--color-code-number)' } },
    { types: ['operator'], style: { color: 'var(--color-code-fg)' } },
    { types: ['punctuation'], style: { color: 'var(--color-code-punctuation)' } },
    { types: ['variable', 'parameter'], style: { color: 'var(--color-code-fg)' } },
    { types: ['property', 'attr-name'], style: { color: 'var(--color-code-property)' } },
    { types: ['builtin', 'class-name', 'constant', 'symbol'], style: { color: 'var(--color-code-type)' } },
    { types: ['regex'], style: { color: 'var(--color-primary-container)' } },
    { types: ['inserted'], style: { color: 'var(--color-code-inserted)' } },
    { types: ['deleted'], style: { color: 'var(--color-code-deleted)' } },
  ],
}

const warmShikiTheme = {
  name: 'warm-code',
  type: 'dark' as const,
  fg: 'var(--color-code-fg)',
  bg: 'transparent',
  tokenColors: [
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: 'var(--color-code-comment)', fontStyle: 'italic' } },
    { scope: ['string', 'string.quoted', 'string.template', 'string.other.link'], settings: { foreground: 'var(--color-code-string)' } },
    { scope: ['string.regexp'], settings: { foreground: 'var(--color-primary-container)' } },
    { scope: ['keyword', 'keyword.control', 'storage', 'storage.type', 'storage.modifier'], settings: { foreground: 'var(--color-code-keyword)' } },
    { scope: ['keyword.operator'], settings: { foreground: 'var(--color-code-keyword)' } },
    { scope: ['entity.name.function', 'support.function'], settings: { foreground: 'var(--color-code-function)' } },
    { scope: ['entity.name.type', 'support.type', 'support.class', 'entity.name.class', 'entity.other.inherited-class'], settings: { foreground: 'var(--color-code-type)' } },
    { scope: ['entity.name.type.parameter'], settings: { foreground: 'var(--color-code-number)' } },
    { scope: ['variable', 'variable.other', 'variable.other.readwrite'], settings: { foreground: 'var(--color-code-fg)' } },
    { scope: ['variable.parameter'], settings: { foreground: 'var(--color-code-parameter)' } },
    { scope: ['variable.other.property', 'support.type.property-name', 'meta.object-literal.key'], settings: { foreground: 'var(--color-code-property)' } },
    { scope: ['variable.other.constant', 'variable.other.enummember'], settings: { foreground: 'var(--color-code-type)' } },
    { scope: ['constant.numeric', 'constant.language'], settings: { foreground: 'var(--color-code-number)' } },
    { scope: ['punctuation', 'meta.brace', 'meta.bracket'], settings: { foreground: 'var(--color-code-punctuation)' } },
    { scope: ['entity.name.tag', 'punctuation.definition.tag'], settings: { foreground: 'var(--color-code-keyword)' } },
    { scope: ['entity.other.attribute-name'], settings: { foreground: 'var(--color-code-property)' } },
    { scope: ['meta.decorator', 'punctuation.decorator'], settings: { foreground: 'var(--color-code-type)' } },
    { scope: ['markup.inserted', 'punctuation.definition.inserted'], settings: { foreground: 'var(--color-code-inserted)' } },
    { scope: ['markup.deleted', 'punctuation.definition.deleted'], settings: { foreground: 'var(--color-code-deleted)' } },
    { scope: ['markup.heading', 'entity.name.section'], settings: { foreground: 'var(--color-code-function)', fontStyle: 'bold' } },
    { scope: ['markup.bold'], settings: { fontStyle: 'bold' } },
    { scope: ['markup.italic'], settings: { fontStyle: 'italic' } },
  ],
}

const CODE_AREA_PADDING = '0.5rem 12px'
const CODE_LINE_HEIGHT = 1.7
/** 流式切段时尾部至少保留的字符数：避免每隔一两行就新增一个 Highlight 实例 */
const CODE_STREAM_MIN_TAIL = 200

type CodeLexMode =
  | 'normal'
  | 'blockComment'
  | 'template'
  | 'singleQuote'
  | 'doubleQuote'
  | 'tripleDouble'
  | 'tripleSingle'

/**
 * v1.5.0 流式分段（与 MarkdownRenderer.findSafeStreamingCut 同思路）：
 * 返回可"封顶"的前缀长度——最后一个不处于块注释 / JS 模板串（含 ${} 嵌套）/
 * Python 三引号内部的空行之后的位置。切点处词法状态干净，段内单独
 * tokenize 与全文 tokenize 结果一致；封顶段交给 memo 组件后全程零重算，
 * 每帧只需重高亮尾部（原来流式代码每 50ms 全文重 tokenize，O(n²)）。
 *
 * 已知取舍：未跟踪的跨行构造（Rust 原始串 r#".."#、Lua [[..]] 等）内的
 * 空行会被误判为切点，尾部配色在封顶前可能短暂偏差，流式结束后全文
 * 重渲染自愈。
 */
export function findSafeCodeCut(text: string): number {
  let mode: CodeLexMode = 'normal'
  let templateExprDepth = 0
  let lastSafeCut = 0
  let lineStart = 0
  let i = 0
  const n = text.length

  while (i < n) {
    const ch = text[i]!
    switch (mode) {
      case 'singleQuote':
        if (ch === '\\') { i += 2; continue }
        if (ch === "'") mode = 'normal'
        break
      case 'doubleQuote':
        if (ch === '\\') { i += 2; continue }
        if (ch === '"') mode = 'normal'
        break
      case 'template':
        if (ch === '\\') { i += 2; continue }
        if (ch === '`') {
          mode = 'normal'
        } else if (ch === '$' && text[i + 1] === '{') {
          templateExprDepth += 1
          mode = 'normal'
          i += 2
          continue
        }
        break
      case 'blockComment':
        if (ch === '*' && text[i + 1] === '/') { mode = 'normal'; i += 2; continue }
        break
      case 'tripleDouble':
        if (ch === '\\') { i += 2; continue }
        if (ch === '"' && text[i + 1] === '"' && text[i + 2] === '"') { mode = 'normal'; i += 3; continue }
        break
      case 'tripleSingle':
        if (ch === '\\') { i += 2; continue }
        if (ch === "'" && text[i + 1] === "'" && text[i + 2] === "'") { mode = 'normal'; i += 3; continue }
        break
      default:
        if (ch === '"' && text[i + 1] === '"' && text[i + 2] === '"') { mode = 'tripleDouble'; i += 3; continue }
        if (ch === "'" && text[i + 1] === "'" && text[i + 2] === "'") { mode = 'tripleSingle'; i += 3; continue }
        if (ch === "'") { mode = 'singleQuote'; break }
        if (ch === '"') { mode = 'doubleQuote'; break }
        if (ch === '`') { mode = 'template'; break }
        if (ch === '/' && text[i + 1] === '*') { mode = 'blockComment'; i += 2; continue }
        if (ch === '}' && templateExprDepth > 0) {
          templateExprDepth -= 1
          if (templateExprDepth === 0) mode = 'template'
        }
        break
    }

    if (ch === '\n') {
      // 字符串/模板内的换行不会落在 normal 状态，天然排除
      if (mode === 'normal' && templateExprDepth === 0 && text.slice(lineStart, i).trim() === '') {
        lastSafeCut = i + 1
      }
      lineStart = i + 1
    }
    i += 1
  }

  if (n - lastSafeCut < CODE_STREAM_MIN_TAIL) return 0
  return lastSafeCut
}

type ShikiHighlighterProps = {
  language: string
  theme: typeof warmShikiTheme
  engine: unknown
  showLineNumbers: boolean
  showLanguage: boolean
  addDefaultStyles: boolean
  style: CSSProperties
  children: string
}

type ReactShikiModule = {
  ShikiHighlighter: ComponentType<any>
  createJavaScriptRegexEngine: (options: { forgiving: boolean }) => unknown
}

type ShikiRuntime = {
  Highlighter: ComponentType<ShikiHighlighterProps>
  engine: unknown
}

let shikiRuntimePromise: Promise<ShikiRuntime | null> | null = null

function canUseShikiRuntime(): boolean {
  if (import.meta.env.MODE === 'test') return false
  if (typeof window === 'undefined') return false

  try {
    new RegExp('(?<name>a)')
    new RegExp('(?<=a)b')
  } catch {
    return false
  }

  const ua = window.navigator.userAgent
  const chromiumLike = /\b(Chrome|Chromium|CriOS|Edg|OPR|Firefox)\b/.test(ua)
  const safariVersion = /\bVersion\/(\d+)(?:\.\d+)?\b.*\bSafari\//.exec(ua)
  if (!chromiumLike && safariVersion && Number(safariVersion[1]) <= 15) {
    return false
  }

  return true
}

function loadShikiRuntime(): Promise<ShikiRuntime | null> {
  if (!canUseShikiRuntime()) return Promise.resolve(null)
  shikiRuntimePromise ??= import('react-shiki')
    .then((mod) => {
      const shiki = mod as unknown as ReactShikiModule
      return {
        Highlighter: shiki.ShikiHighlighter as ComponentType<ShikiHighlighterProps>,
        engine: shiki.createJavaScriptRegexEngine({ forgiving: true }),
      }
    })
    .catch(() => null)
  return shikiRuntimePromise
}

type PrismTokenLinesProps = {
  code: string
  language?: string
  showLineNumbers: boolean
  lineNumberOffset?: number
  /** normalizeTokens 对以 \n 结尾的文本会多产一个空行；封顶段都以 \n 结尾，需丢弃该伪影 */
  dropTrailingEmptyLine?: boolean
}

function PrismTokenLines({
  code,
  language,
  showLineNumbers,
  lineNumberOffset = 0,
  dropTrailingEmptyLine = false,
}: PrismTokenLinesProps) {
  return (
    <Highlight
      theme={warmPrismTheme}
      code={code}
      language={language || 'text'}
    >
      {({ tokens, getLineProps, getTokenProps }) => {
        const lines = dropTrailingEmptyLine && code.endsWith('\n') && tokens.length > 0
          ? tokens.slice(0, -1)
          : tokens
        return (
          <>
            {lines.map((line, index) => (
              <span
                key={index}
                {...getLineProps({ line })}
                data-line-number={showLineNumbers ? lineNumberOffset + index + 1 : undefined}
              >
                {showLineNumbers && (
                  <span className="mr-3 inline-block min-w-[2.5ch] select-none text-right text-[var(--color-text-tertiary)]">
                    {lineNumberOffset + index + 1}
                  </span>
                )}
                {line.map((token, key) => (
                  <span key={key} {...getTokenProps({ token })} />
                ))}
              </span>
            ))}
          </>
        )
      }}
    </Highlight>
  )
}

const MemoPrismTokenLines = memo(PrismTokenLines)

type StreamingSegmentState = {
  committedText: string
  segments: string[]
}

/**
 * 流式代码的分段视图：已封顶段走 MemoPrismTokenLines（props 不变即不重
 * tokenize），尾部未封顶部分每帧重高亮（体量在尾段级）。
 * 段数只增不减、段内容不变，key 用下标即稳定。
 */
const StreamingPrismCode = memo(function StreamingPrismCode({
  code,
  language,
  showLineNumbers,
}: {
  code: string
  language?: string
  showLineNumbers: boolean
}) {
  const segmentStateRef = useRef<StreamingSegmentState>({ committedText: '', segments: [] })
  const state = segmentStateRef.current

  // 新内容不再以已封顶前缀开头（窗口滑动/重置）时从头分段
  if (!code.startsWith(state.committedText)) {
    state.committedText = ''
    state.segments = []
  }

  let rest = code.slice(state.committedText.length)
  for (;;) {
    const cut = findSafeCodeCut(rest)
    if (cut <= 0) break
    const segment = rest.slice(0, cut)
    state.segments.push(segment)
    state.committedText += segment
    rest = rest.slice(cut)
  }

  let lineOffset = 0
  return (
    <>
      {state.segments.map((segment, index) => {
        const node = (
          <MemoPrismTokenLines
            key={index}
            code={segment}
            language={language}
            showLineNumbers={showLineNumbers}
            lineNumberOffset={lineOffset}
            dropTrailingEmptyLine
          />
        )
        lineOffset += segment.split('\n').length - 1
        return node
      })}
      <PrismTokenLines
        code={rest}
        language={language}
        showLineNumbers={showLineNumbers}
        lineNumberOffset={lineOffset}
      />
    </>
  )
})

function PrismCodeContent({
  code,
  language,
  showLineNumbers,
  wrapLongLines,
  streaming = false,
}: {
  code: string
  language?: string
  showLineNumbers: boolean
  wrapLongLines: boolean
  streaming?: boolean
}) {
  return (
    <pre
      data-code-viewer-content=""
      data-highlight-engine="prism"
      style={{
        margin: 0,
        padding: CODE_AREA_PADDING,
        fontFamily: 'var(--font-mono)',
        fontSize: '13px',
        lineHeight: String(CODE_LINE_HEIGHT),
        whiteSpace: wrapLongLines ? 'pre-wrap' : 'pre',
        wordBreak: wrapLongLines ? 'break-word' : 'normal',
        color: 'var(--color-code-fg)',
      }}
    >
      {streaming ? (
        <StreamingPrismCode code={code} language={language} showLineNumbers={showLineNumbers} />
      ) : (
        <PrismTokenLines code={code} language={language} showLineNumbers={showLineNumbers} />
      )}
    </pre>
  )
}

function CodeArea({
  code,
  language,
  showLineNumbers,
  wrapLongLines,
  streaming = false,
}: {
  code: string
  language?: string
  showLineNumbers: boolean
  wrapLongLines: boolean
  streaming?: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [runtime, setRuntime] = useState<ShikiRuntime | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    loadShikiRuntime().then((nextRuntime) => {
      if (!cancelled) setRuntime(nextRuntime)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // 注意：不要在 code 变化时重置 loaded——流式场景每 50ms 变一次，重置会让
  // Prism 兜底层每帧重新挂载并全文 tokenize（与 Shiki 双跑），还会闪烁。
  // 只在语言切换时重回兜底；Shiki 异步追帧期间短暂展示上一帧高亮可接受。
  useEffect(() => {
    setLoaded(false)
  }, [language])

  useEffect(() => {
    if (!runtime) return
    const el = containerRef.current
    if (!el) return
    const check = () => {
      const shikiContainer = el.querySelector('[data-testid="shiki-container"]')
      if (shikiContainer?.querySelector('code')) {
        setLoaded(true)
      }
    }
    check()
    const observer = new MutationObserver(check)
    observer.observe(el, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [runtime])

  const ShikiHighlighter = runtime?.Highlighter

  return (
    <div
      ref={containerRef}
      data-has-line-numbers={showLineNumbers ? 'true' : 'false'}
      className="code-viewer-area relative max-h-[420px] overflow-auto bg-[var(--color-code-bg)]"
    >
      {(!ShikiHighlighter || !loaded) && (
        <PrismCodeContent
          code={code}
          language={language}
          showLineNumbers={showLineNumbers}
          wrapLongLines={wrapLongLines}
          streaming={streaming}
        />
      )}
      {ShikiHighlighter && (
        <div
          data-code-viewer-content=""
          data-highlight-engine="shiki"
          style={
            loaded
              ? { padding: CODE_AREA_PADDING }
              : {
                  position: 'absolute',
                  inset: 0,
                  opacity: 0,
                  pointerEvents: 'none',
                  padding: CODE_AREA_PADDING,
                }
          }
        >
          <ShikiHighlighter
            language={language || 'text'}
            theme={warmShikiTheme}
            engine={runtime.engine}
            showLineNumbers={showLineNumbers}
            showLanguage={false}
            addDefaultStyles={false}
            style={{
              margin: 0,
              fontFamily: 'var(--font-mono)',
              fontSize: '13px',
              lineHeight: String(CODE_LINE_HEIGHT),
              whiteSpace: wrapLongLines ? 'pre-wrap' : 'pre',
              wordBreak: wrapLongLines ? 'break-word' : 'normal',
            }}
          >
            {code}
          </ShikiHighlighter>
        </div>
      )}
    </div>
  )
}

export function CodeViewer({ code, language, maxLines = 20, showLineNumbers = false, wrapLongLines = false, streaming = false }: Props) {
  const t = useTranslation()
  const [expanded, setExpanded] = useState(false)

  const allLines = code.split('\n')
  const isTruncated = !expanded && allLines.length > maxLines
  const visibleCode = isTruncated ? allLines.slice(0, maxLines).join('\n') : code

  const effectiveShowLineNumbers = showLineNumbers && !!language && language !== 'text'
  const languageLabel = language || 'code'
  const lineCountLabel = `${allLines.length} ${allLines.length === 1 ? 'line' : 'lines'}`
  const showExpandToggle = allLines.length > maxLines

  return (
    <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-code-bg)]">
      {/* Header（P0-6：工具卡头部统一 surface-container-low） */}
      <div className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 py-1.5 text-[11px] text-[var(--color-text-tertiary)]">
        <div className="flex items-center gap-3">
          <span className="font-semibold uppercase tracking-[0.14em]">{languageLabel}</span>
          <span>{lineCountLabel}</span>
        </div>
        <CopyButton
          text={code}
          className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-2 py-1 text-[11px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-container-high)] hover:text-[var(--color-text-primary)]"
        />
      </div>

      {/* Code area */}
      <CodeArea
        code={visibleCode}
        language={language}
        showLineNumbers={effectiveShowLineNumbers}
        wrapLongLines={wrapLongLines}
        streaming={streaming}
      />

      {/* Expand/collapse toggle */}
      {showExpandToggle && (
        <button
          onClick={() => setExpanded((value) => !value)}
          className="w-full border-t border-[var(--color-border)] bg-[var(--color-surface-container-low)] py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-container-high)] hover:text-[var(--color-text-primary)]"
        >
          {expanded
            ? t('codeViewer.collapse')
            : t('codeViewer.showMoreLines', { count: allLines.length - maxLines })}
        </button>
      )}
    </div>
  )
}
