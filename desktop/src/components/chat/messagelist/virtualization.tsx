// v1.7.0 结构拆分第①批（virtualization / renderModel / scroll / find）：
// scroll + virtualization + conversation-navigation 域从
// components/chat/MessageList.tsx 逐字移出（原 946-1041、1063-1095、
// 1208-1565 行），逻辑零改动；门面保留为入口。MAX_SCROLL_SNAPSHOTS、
// VirtualTranscriptItem/VirtualTranscriptWindow 等内部符号保持模块私有。

import { useRef, useLayoutEffect, memo, type ReactNode } from 'react'
import { isTouchH5Document } from '../../../lib/touchH5'
import type { ConversationNavigationItem } from '../ConversationNavigator'
import type { VirtualRenderItemMetric } from '../virtualHeightCache'
import type { RenderItem } from './renderModel'
import type { UIMessage } from '../../../types/chat'

const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 48
export const SCROLL_BOTTOM_SENTINEL = 1_000_000_000
const MAX_SCROLL_SNAPSHOTS = 100
const VIRTUALIZE_MIN_RENDER_ITEMS = 120
const VIRTUALIZE_MIN_CONTENT_CHARS = 120_000
// Touch-H5 disables content-visibility paint skipping for selection
// correctness (globals.css), which makes virtualization the only paint bound
// for long transcripts there — so it kicks in at half the desktop thresholds.
const TOUCH_H5_VIRTUALIZE_MIN_RENDER_ITEMS = 60
const TOUCH_H5_VIRTUALIZE_MIN_CONTENT_CHARS = 60_000
export const VIRTUAL_OVERSCAN_PX = 1200
export const VIRTUAL_DEFAULT_VIEWPORT_HEIGHT = 720
export const VIRTUAL_MIN_ITEM_HEIGHT = 48
export const VIRTUAL_MAX_ITEM_HEIGHT = 24_000
// Windows WebView2 can report up to 2px oscillations for live chat content;
// don't convert those into bottom-scroll corrections.
export const CONTENT_RESIZE_FOLLOW_JITTER_MAX_DELTA_PX = 2
export const USER_SCROLL_INTENT_WINDOW_MS = 500
/** v1.5.0 历史分页：滚动条距顶部不足该像素时触发向前翻页。 */
export const EARLIER_HISTORY_TRIGGER_PX = 240
export const CONVERSATION_NAVIGATION_MIN_ITEMS = 4
export const CONVERSATION_NAVIGATION_FULL_MIN_WIDTH_PX = 960
export const CONVERSATION_NAVIGATION_COMPACT_MIN_WIDTH_PX = 560
export const STREAMING_ASSISTANT_NAVIGATION_KEY = 'streaming-assistant-message'
export const CHAT_SCROLL_AREA_CLASS = [
  'chat-scroll-area',
  '[scrollbar-width:auto]',
  '[scrollbar-color:color-mix(in_srgb,var(--color-outline)_72%,transparent)_transparent]',
  '[&::-webkit-scrollbar]:w-2.5',
  '[&::-webkit-scrollbar-track]:bg-transparent',
  '[&::-webkit-scrollbar-thumb]:rounded-full',
  '[&::-webkit-scrollbar-thumb]:border-[3px]',
  '[&::-webkit-scrollbar-thumb]:border-transparent',
  '[&::-webkit-scrollbar-thumb]:bg-[color-mix(in_srgb,var(--color-outline)_74%,transparent)]',
  '[&::-webkit-scrollbar-thumb]:bg-clip-content',
  '[&::-webkit-scrollbar-thumb:hover]:border-2',
  '[&::-webkit-scrollbar-thumb:hover]:bg-[color-mix(in_srgb,var(--color-outline)_90%,transparent)]',
].join(' ')
export const CHAT_RENDER_ITEM_CLASS = [
  'chat-render-item',
].join(' ')

export function isRenderItemFullyVisibleInChatScroller(renderItem: HTMLElement) {
  const scroller = renderItem.closest<HTMLElement>('.chat-scroll-area')
  if (!scroller) return false

  const itemRect = renderItem.getBoundingClientRect()
  const scrollerRect = scroller.getBoundingClientRect()
  return itemRect.top >= scrollerRect.top &&
    itemRect.bottom <= scrollerRect.bottom &&
    itemRect.left >= scrollerRect.left &&
    itemRect.right <= scrollerRect.right
}

type SessionScrollSnapshot = {
  scrollTop: number
  wasAtBottom: boolean
}

export type VirtualViewport = {
  scrollTop: number
  viewportHeight: number
}

type VirtualTranscriptItem = {
  item: RenderItem
  index: number
}

type VirtualTranscriptWindow = {
  enabled: boolean
  beforeHeight: number
  afterHeight: number
  items: VirtualTranscriptItem[]
  offsets: number[]
  totalHeight: number
}

export const sessionScrollSnapshots = new Map<string, SessionScrollSnapshot>()

export function resetSessionScrollSnapshotsForTests() {
  sessionScrollSnapshots.clear()
}

export function isNearScrollBottom(element: HTMLElement) {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight <=
    AUTO_SCROLL_BOTTOM_THRESHOLD_PX
  )
}

export function rememberSessionScroll(sessionId: string, element: HTMLElement) {
  if (sessionScrollSnapshots.size >= MAX_SCROLL_SNAPSHOTS && !sessionScrollSnapshots.has(sessionId)) {
    const oldestSessionId = sessionScrollSnapshots.keys().next().value
    if (oldestSessionId) {
      sessionScrollSnapshots.delete(oldestSessionId)
    }
  }

  sessionScrollSnapshots.set(sessionId, {
    scrollTop: element.scrollTop,
    wasAtBottom: isNearScrollBottom(element),
  })
}

function getBottomScrollTop(element: HTMLElement) {
  return Math.max(0, element.scrollHeight - element.clientHeight)
}

export function setScrollTopWithoutLayoutRead(element: HTMLElement, scrollTop: number) {
  element.scrollTop = Math.max(0, scrollTop)
}

export function setScrollToBottomWithoutLayoutRead(element: HTMLElement, behavior: ScrollBehavior) {
  if (typeof element.scrollTo === 'function') {
    try {
      element.scrollTo({ top: SCROLL_BOTTOM_SENTINEL, behavior })
    } catch {
      element.scrollTo(0, SCROLL_BOTTOM_SENTINEL)
    }
  }
  element.scrollTop = SCROLL_BOTTOM_SENTINEL

  // Browsers clamp the large value to the true bottom without needing us to
  // synchronously read layout metrics. JSDOM test doubles do not clamp, so keep
  // the old numeric behavior there as a fallback.
  if (element.scrollTop === SCROLL_BOTTOM_SENTINEL) {
    element.scrollTop = getBottomScrollTop(element)
  }
}

export function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function getRenderItemKey(item: RenderItem) {
  return item.kind === 'tool_group' ? item.id : item.message.id
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function getShallowStringWeight(value: unknown, depth = 0): number {
  if (typeof value === 'string') return value.length
  if (!value || depth > 1) return 0
  if (Array.isArray(value)) {
    return value.slice(0, 12).reduce((total, item) => total + getShallowStringWeight(item, depth + 1), 0)
  }
  if (!isRecordValue(value)) return 0

  let total = 0
  for (const item of Object.values(value).slice(0, 24)) {
    total += getShallowStringWeight(item, depth + 1)
    if (total >= VIRTUALIZE_MIN_CONTENT_CHARS) return total
  }
  return total
}

function getMessageContentWeight(message: UIMessage): number {
  switch (message.type) {
    case 'user_text':
    case 'assistant_text':
    case 'thinking':
    case 'system':
      return message.content.length
    case 'tool_use':
      return getShallowStringWeight(message.input) + (message.partialInput?.length ?? 0)
    case 'tool_result':
      return getShallowStringWeight(message.content)
    case 'permission_request':
      return getShallowStringWeight(message.input) + (message.description?.length ?? 0)
    case 'error':
      return message.message.length
    case 'compact_summary':
      return message.title.length + (message.summary?.length ?? 0)
    case 'goal_event':
      return (message.objective?.length ?? 0) + (message.message?.length ?? 0)
    case 'memory_event':
      return (message.message?.length ?? 0) + message.files.reduce((total, file) => total + file.path.length + (file.summary?.length ?? 0), 0)
    case 'background_task':
      return getShallowStringWeight(message.task)
    case 'task_summary':
      return message.tasks.reduce((total, task) => total + task.subject.length + (task.activeForm?.length ?? 0), 0)
  }
}

export function getRenderItemContentWeight(item: RenderItem): number {
  if (item.kind === 'message') return getMessageContentWeight(item.message)
  return item.toolCalls.reduce((total, toolCall) => total + getMessageContentWeight(toolCall), 0)
}

export function shouldVirtualizeRenderItems(
  metrics: VirtualRenderItemMetric[],
  touchH5 = isTouchH5Document(),
) {
  const minRenderItems = touchH5 ? TOUCH_H5_VIRTUALIZE_MIN_RENDER_ITEMS : VIRTUALIZE_MIN_RENDER_ITEMS
  const minContentChars = touchH5 ? TOUCH_H5_VIRTUALIZE_MIN_CONTENT_CHARS : VIRTUALIZE_MIN_CONTENT_CHARS
  if (metrics.length >= minRenderItems) return true

  let totalWeight = 0
  for (const metric of metrics) {
    totalWeight += metric.contentWeight
    if (totalWeight >= minContentChars) return true
  }
  return false
}

function countLineBreaksCapped(content: string, maxLines: number) {
  let lineBreaks = 0
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) {
      lineBreaks += 1
      if (lineBreaks >= maxLines) return lineBreaks
    }
  }
  return lineBreaks
}

function estimateTextHeight(content: string, baseHeight: number) {
  const sample = content.length > 12_000 ? content.slice(0, 12_000) : content
  const sampledLineBreaks = countLineBreaksCapped(sample, 900)
  const explicitLines = content.length > sample.length
    ? Math.ceil((sampledLineBreaks + 1) * (content.length / sample.length))
    : sampledLineBreaks + 1
  const wrappedLines = Math.ceil(content.length / 76)
  const estimated = baseHeight + Math.max(explicitLines, wrappedLines) * 22
  return clampNumber(estimated, VIRTUAL_MIN_ITEM_HEIGHT, VIRTUAL_MAX_ITEM_HEIGHT)
}

function estimateMessageHeight(message: UIMessage): number {
  switch (message.type) {
    case 'user_text':
      return estimateTextHeight(message.content, message.attachments?.length ? 140 : 74)
    case 'assistant_text':
      return estimateTextHeight(message.content, 96)
    case 'thinking':
      return estimateTextHeight(message.content, 88)
    case 'tool_use':
      return clampNumber(92 + Math.ceil(getMessageContentWeight(message) / 120) * 18, 72, 2200)
    case 'tool_result':
      return clampNumber(88 + Math.ceil(getMessageContentWeight(message) / 120) * 18, 64, 2200)
    case 'background_task':
    case 'goal_event':
    case 'memory_event':
    case 'permission_request':
    case 'task_summary':
      return 110
    case 'compact_summary':
      return message.summary ? clampNumber(92 + Math.ceil(message.summary.length / 90) * 20, 80, 1800) : 70
    case 'error':
    case 'system':
      return 64
  }
}

export function estimateRenderItemHeight(item: RenderItem): number {
  if (item.kind === 'message') return estimateMessageHeight(item.message)
  const textWeight = getRenderItemContentWeight(item)
  return clampNumber(92 + item.toolCalls.length * 78 + Math.ceil(textWeight / 140) * 16, 88, 2600)
}

function getMessageMetricSignature(message: UIMessage): string {
  switch (message.type) {
    case 'user_text':
      return `${message.type}:${message.content.length}:${message.attachments?.length ?? 0}:${message.pending ? 1 : 0}`
    case 'assistant_text':
    case 'thinking':
    case 'system':
      return `${message.type}:${message.content.length}`
    case 'tool_use':
      return `${message.type}:${message.toolName}:${message.toolUseId}:${message.partialInput?.length ?? 0}:${message.isPending ? 1 : 0}:${message.status ?? ''}`
    case 'tool_result':
      return `${message.type}:${message.toolUseId}:${message.isError ? 1 : 0}`
    case 'compact_summary':
      return `${message.type}:${message.phase ?? ''}:${message.title.length}:${message.summary?.length ?? 0}`
    case 'goal_event':
      return `${message.type}:${message.action}:${message.status ?? ''}:${message.objective?.length ?? 0}:${message.message?.length ?? 0}`
    case 'memory_event':
      return `${message.type}:${message.event}:${message.files.length}:${message.message?.length ?? 0}`
    case 'background_task':
      return `${message.type}:${message.task.taskId}:${message.task.status}:${message.task.updatedAt}`
    case 'permission_request':
      return `${message.type}:${message.requestId}:${message.toolUseId ?? ''}:${message.description?.length ?? 0}`
    case 'error':
      return `${message.type}:${message.code}:${message.message.length}`
    case 'task_summary':
      return `${message.type}:${message.tasks.length}:${message.tasks.map((task) => task.id).join(',')}`
  }
}

export function getRenderItemMetricSignature(item: RenderItem): string {
  if (item.kind === 'message') return getMessageMetricSignature(item.message)
  return item.toolCalls.map(getMessageMetricSignature).join('|')
}

function findVirtualStartIndex(offsets: number[], target: number) {
  let low = 0
  let high = offsets.length - 1
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if ((offsets[mid + 1] ?? offsets[mid] ?? 0) < target) {
      low = mid + 1
    } else {
      high = mid
    }
  }
  return Math.max(0, low)
}

function findVirtualEndIndex(offsets: number[], target: number) {
  let low = 0
  let high = offsets.length - 1
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if ((offsets[mid] ?? 0) <= target) {
      low = mid + 1
    } else {
      high = mid
    }
  }
  return clampNumber(low + 1, 0, offsets.length - 1)
}

export function buildVirtualItemOffsets(
  itemKeys: string[],
  metrics: VirtualRenderItemMetric[],
  measuredHeights: Map<string, number>,
) {
  const offsets = new Array<number>(itemKeys.length + 1)
  offsets[0] = 0
  for (let index = 0; index < itemKeys.length; index += 1) {
    const measuredHeight = measuredHeights.get(itemKeys[index]!)
    const height = measuredHeight && measuredHeight > 0
      ? measuredHeight
      : metrics[index]?.estimatedHeight ?? VIRTUAL_MIN_ITEM_HEIGHT
    offsets[index + 1] = offsets[index]! + height
  }
  return offsets
}

export const CONVERSATION_NAVIGATION_READING_ANCHOR_RATIO = 0.25

export function getActiveConversationNavigationItemId(
  items: ConversationNavigationItem[],
  offsets: number[],
  scrollTop: number,
  viewportHeight: number,
) {
  if (items.length === 0) return null
  if (scrollTop <= 1) return items[0]!.id
  const readingAnchor = scrollTop + viewportHeight * CONVERSATION_NAVIGATION_READING_ANCHOR_RATIO
  let activeItem = items[0]!

  for (const item of items) {
    if ((offsets[item.renderIndex] ?? 0) > readingAnchor) break
    activeItem = item
  }

  return activeItem.id
}

export function getConversationNavigationTargetScrollTop(
  item: ConversationNavigationItem,
  offsets: number[],
  viewportHeight: number,
  totalHeight: number,
) {
  const targetTop = offsets[item.renderIndex] ?? 0
  const readingAnchor = viewportHeight * CONVERSATION_NAVIGATION_READING_ANCHOR_RATIO
  return clampNumber(targetTop - readingAnchor, 0, Math.max(0, totalHeight - viewportHeight))
}

export function buildVirtualTranscriptWindow(
  renderItems: RenderItem[],
  itemKeys: string[],
  metrics: VirtualRenderItemMetric[],
  measuredHeights: Map<string, number>,
  viewport: VirtualViewport,
  overscanPx: number,
): VirtualTranscriptWindow {
  const offsets = buildVirtualItemOffsets(itemKeys, metrics, measuredHeights)
  const totalHeight = offsets[renderItems.length] ?? 0
  if (!shouldVirtualizeRenderItems(metrics)) {
    return {
      enabled: false,
      beforeHeight: 0,
      afterHeight: 0,
      items: renderItems.map((item, index) => ({ item, index })),
      offsets,
      totalHeight,
    }
  }

  const viewportHeight = viewport.viewportHeight || VIRTUAL_DEFAULT_VIEWPORT_HEIGHT
  const maxScrollTop = Math.max(0, totalHeight - viewportHeight)
  const scrollTop = clampNumber(viewport.scrollTop, 0, maxScrollTop)
  const windowTop = Math.max(0, scrollTop - overscanPx)
  const windowBottom = Math.min(totalHeight, scrollTop + viewportHeight + overscanPx)
  const startIndex = findVirtualStartIndex(offsets, windowTop)
  const endIndex = Math.min(renderItems.length, findVirtualEndIndex(offsets, windowBottom))

  return {
    enabled: true,
    beforeHeight: offsets[startIndex] ?? 0,
    afterHeight: totalHeight - (offsets[endIndex] ?? totalHeight),
    items: renderItems.slice(startIndex, endIndex).map((item, offset) => ({
      item,
      index: startIndex + offset,
    })),
    offsets,
    totalHeight,
  }
}

const VIRTUAL_SPACER_CHUNK_PX = 800

export function VirtualSpacer({ height, position }: { height: number; position: 'top' | 'bottom' }) {
  if (height <= 0) return null
  if (height <= VIRTUAL_SPACER_CHUNK_PX) {
    return (
      <div
        data-virtual-spacer={position}
        aria-hidden="true"
        style={{ height }}
      />
    )
  }

  // Splitting the spacer into chunks lets the WebView keep painting placeholder
  // boxes via content-visibility:auto + contain-intrinsic-size, instead of
  // leaving a single huge area unpainted while React reconciles the window.
  const chunkCount = Math.max(1, Math.ceil(height / VIRTUAL_SPACER_CHUNK_PX))
  const chunkHeight = Math.floor(height / chunkCount)
  const remainder = height - chunkHeight * chunkCount
  const chunks: Array<{ key: string; px: number }> = []
  for (let i = 0; i < chunkCount; i++) {
    const px = i === chunkCount - 1 ? chunkHeight + remainder : chunkHeight
    chunks.push({ key: `${position}-${i}`, px })
  }

  return (
    <div data-virtual-spacer={position} aria-hidden="true">
      {chunks.map((chunk) => (
        <div
          key={chunk.key}
          data-virtual-spacer-chunk={position}
          style={{
            height: chunk.px,
            contentVisibility: 'auto',
            containIntrinsicSize: `0 ${chunk.px}px`,
          }}
        />
      ))}
    </div>
  )
}

export const MeasuredRenderItem = memo(function MeasuredRenderItem({
  itemKey,
  onHeightChange,
  highlighted,
  children,
}: {
  itemKey: string
  onHeightChange: (itemKey: string, height: number) => void
  highlighted: boolean
  children: ReactNode
}) {
  const itemRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const node = itemRef.current
    if (!node) return undefined

    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry && Number.isFinite(entry.contentRect.height) && entry.contentRect.height > 0) {
        onHeightChange(itemKey, Math.ceil(entry.contentRect.height))
      }
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [itemKey, onHeightChange])

  return (
    <div
      ref={itemRef}
      data-virtual-message-item={itemKey}
      data-chat-render-item-key={itemKey}
      className={`${CHAT_RENDER_ITEM_CLASS} ${highlighted ? 'chat-render-item--navigation-target' : ''}`}
    >
      {children}
    </div>
  )
})
