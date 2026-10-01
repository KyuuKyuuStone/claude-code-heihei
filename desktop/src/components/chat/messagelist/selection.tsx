// v1.7.0 结构拆分第②批（卡片 / selection / MessageBlock）：selection 域从
// components/chat/MessageList.tsx 逐字移出（原 118-206 行），逻辑零改动；
// 门面保留为入口。getElementForNode 与 CHAT_SELECTION_MENU_* 保持模块私有。

import { createPortal } from 'react-dom'
import { MessageCircle } from 'lucide-react'
import { useTranslation } from '../../../i18n'
import { getSelectionPopoverPosition } from '../../../hooks/useSelectionPopoverDismiss'

export type ChatMessageRole = 'user' | 'assistant'

export type ChatSelectionState = {
  text: string
  x: number
  y: number
}

export type SelectionPointer = {
  clientX: number
  clientY: number
}

const CHAT_SELECTION_MENU_OFFSET = 10
const CHAT_SELECTION_MENU_WIDTH = 158
const CHAT_SELECTION_MENU_HEIGHT = 44

function getElementForNode(node: Node | null): Element | null {
  if (!node) return null
  return node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
}

function getChatSelectionPosition(range: Range, root: HTMLElement, pointer: { clientX: number; clientY: number }) {
  return getSelectionPopoverPosition(range, root, {
    menuWidth: CHAT_SELECTION_MENU_WIDTH,
    menuHeight: CHAT_SELECTION_MENU_HEIGHT,
    offset: CHAT_SELECTION_MENU_OFFSET,
    fallbackPointer: pointer,
  })
}

export function getChatSelectionFromContainer(
  root: HTMLElement | null,
  pointer: SelectionPointer,
): ChatSelectionState | null {
  if (!root) return null
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null

  const range = selection.getRangeAt(0)
  const startElement = getElementForNode(range.startContainer)
  const endElement = getElementForNode(range.endContainer)
  if (!startElement || !endElement || !root.contains(startElement) || !root.contains(endElement)) {
    return null
  }

  const text = selection.toString().trim()
  if (!text) return null

  return {
    ...getChatSelectionPosition(range, root, pointer),
    text,
  }
}

export function getSelectionPointer(event: SelectionPointer): SelectionPointer {
  return {
    clientX: event.clientX,
    clientY: event.clientY,
  }
}

export function ChatSelectionMenu({
  selection,
  onAdd,
  popoverRef,
}: {
  selection: ChatSelectionState | null
  onAdd: () => void
  popoverRef: { current: HTMLButtonElement | null }
}) {
  const t = useTranslation()
  if (!selection) return null

  return createPortal(
    <button
      ref={popoverRef}
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onAdd}
      className="fixed z-[var(--z-popover)] inline-flex h-11 items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-5 text-[15px] font-semibold text-[var(--color-text-primary)] shadow-[var(--shadow-overlay)] transition-colors hover:bg-[var(--color-surface)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
      style={{ left: selection.x, top: selection.y }}
    >
      <MessageCircle size={21} strokeWidth={2.15} className="shrink-0 text-[var(--color-text-primary)]" aria-hidden="true" />
      <span>{t('chat.addSelectionToChat')}</span>
    </button>,
    document.body,
  )
}
