// v1.7.0 结构拆分第①批（virtualization / renderModel / scroll / find）：
// conversation-find 域从 components/chat/MessageList.tsx 逐字移出
// （原 1026-1034、1097-1206 行），逻辑零改动；门面保留为入口。
// collectConversationFindRanges 仅被 paintConversationFindHighlights 内部
// 使用，保持模块私有。

import type { RenderItem } from './renderModel'
import { getRenderItemKey, STREAMING_ASSISTANT_NAVIGATION_KEY } from './virtualization'

export type ConversationFindMatch = {
  renderIndex: number
  renderItemKey: string
  occurrenceIndex: number
  query: string
}

const MAX_CONVERSATION_FIND_MATCHES = 1_000
export const CONVERSATION_FIND_CONTENT_REFRESH_MS = 80

export function findConversationMatches(
  renderItems: RenderItem[],
  streamingText: string,
  query: string,
): ConversationFindMatch[] {
  const needle = query.toLocaleLowerCase()
  if (!needle) return []
  const matches: ConversationFindMatch[] = []

  renderItems.forEach((item, renderIndex) => {
    if (matches.length >= MAX_CONVERSATION_FIND_MATCHES || item.kind !== 'message') return
    const message = item.message
    if (message.type !== 'user_text' && message.type !== 'assistant_text') return
    let occurrenceIndex = 0
    const text = message.content.toLocaleLowerCase()
    let offset = text.indexOf(needle)
    while (offset !== -1 && matches.length < MAX_CONVERSATION_FIND_MATCHES) {
      matches.push({
        renderIndex,
        renderItemKey: getRenderItemKey(item),
        occurrenceIndex,
        query,
      })
      occurrenceIndex += 1
      offset = text.indexOf(needle, offset + needle.length)
    }
  })

  if (matches.length < MAX_CONVERSATION_FIND_MATCHES && streamingText.trim()) {
    const text = streamingText.toLocaleLowerCase()
    let occurrenceIndex = 0
    let offset = text.indexOf(needle)
    while (offset !== -1 && matches.length < MAX_CONVERSATION_FIND_MATCHES) {
      matches.push({
        renderIndex: renderItems.length,
        renderItemKey: STREAMING_ASSISTANT_NAVIGATION_KEY,
        occurrenceIndex,
        query,
      })
      occurrenceIndex += 1
      offset = text.indexOf(needle, offset + needle.length)
    }
  }

  return matches
}

function collectConversationFindRanges(root: Node, query: string) {
  const ranges: Range[] = []
  const needle = query.toLocaleLowerCase()
  if (!needle) return ranges
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT
      if (node.parentElement?.closest('[data-find-bar], script, style, noscript, .material-symbols-outlined')) {
        return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })

  let textNode = walker.nextNode() as Text | null
  while (textNode) {
    const text = textNode.nodeValue?.toLocaleLowerCase() ?? ''
    let offset = text.indexOf(needle)
    while (offset !== -1 && ranges.length < MAX_CONVERSATION_FIND_MATCHES) {
      const range = document.createRange()
      range.setStart(textNode, offset)
      range.setEnd(textNode, offset + needle.length)
      ranges.push(range)
      offset = text.indexOf(needle, offset + needle.length)
    }
    if (ranges.length >= MAX_CONVERSATION_FIND_MATCHES) break
    textNode = walker.nextNode() as Text | null
  }
  return ranges
}

export function clearConversationFindHighlights() {
  const highlights = (globalThis.CSS as any)?.highlights as Map<string, unknown> | undefined
  highlights?.delete('cc-find-results')
  highlights?.delete('cc-find-active')
}

export function paintConversationFindHighlights(root: HTMLElement, match: ConversationFindMatch) {
  const highlights = (globalThis.CSS as any)?.highlights as Map<string, unknown> | undefined
  const HighlightCtor = (globalThis as any).Highlight
  if (!highlights || !HighlightCtor) return

  const resultRanges = collectConversationFindRanges(root, match.query)
  const target = Array.from(root.querySelectorAll<HTMLElement>('[data-chat-render-item-key]'))
    .find((node) => node.dataset.chatRenderItemKey === match.renderItemKey)
  const targetRanges = target
    ? resultRanges.filter((range) => target.contains(range.startContainer))
    : []
  const activeRange = targetRanges[Math.min(match.occurrenceIndex, Math.max(0, targetRanges.length - 1))]

  const results = new HighlightCtor()
  for (const range of resultRanges) results.add(range)
  highlights.set('cc-find-results', results)

  if (activeRange) {
    const active = new HighlightCtor()
    active.add(activeRange)
    active.priority = 1
    highlights.set('cc-find-active', active)
  } else {
    highlights.delete('cc-find-active')
  }
}
