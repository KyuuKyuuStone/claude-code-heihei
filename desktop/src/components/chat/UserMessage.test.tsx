import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const openPreviewLink = vi.hoisted(() => vi.fn(() => true))
vi.mock('../../lib/openPreviewLink', () => ({ openPreviewLink }))

import { UserMessage } from './UserMessage'
import { useSettingsStore } from '../../stores/settingsStore'

function bubbleOf(container: HTMLElement): HTMLElement {
  const bubble = container.querySelector<HTMLElement>('[data-message-body="user"]')
  if (!bubble) throw new Error('user message bubble not found')
  return bubble
}

describe('UserMessage', () => {
  afterEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    openPreviewLink.mockClear().mockReturnValue(true)
  })

  it('keeps long URLs inside the message bubble', () => {
    const longUrl = `https://cn.bing.com/search?q=${'encoded'.repeat(60)}`

    const { container } = render(<UserMessage content={longUrl} />)

    const shell = container.querySelector('[data-message-shell="user"]')
    const bubble = bubbleOf(container)

    expect(shell?.className).toContain('min-w-0')
    expect(bubble.className).toContain('min-w-0')
    expect(bubble.className).toContain('max-w-full')
    expect(bubble.className).toContain('whitespace-pre-wrap')
    expect(bubble.style.overflowWrap).toBe('anywhere')
    expect(bubble.style.wordBreak).toBe('break-word')
    // The long text now lives in the anchor, so it has to wrap there too.
    expect(screen.getByRole('link', { name: longUrl }).className).toContain('[overflow-wrap:anywhere]')
  })

  // The copy label was a hardcoded "Copy prompt" literal, so it stayed English
  // under every locale. English is also what `chat.copyPrompt` resolves to, so
  // only a non-English locale can tell the wiring from the old literal.
  it('translates the copy action label instead of hardcoding English', () => {
    useSettingsStore.setState({ locale: 'zh' })

    render(<UserMessage content="把这条复制走" />)

    expect(screen.getByRole('button', { name: '复制提示词' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Copy prompt' })).toBeNull()
  })
})

// #1145. The prompt bubble rendered raw text, so a URL the user typed (or pasted
// back from an earlier reply) could never be clicked — the only clickable copy
// lived in the assistant's output card.
describe('UserMessage bare-URL linkify', () => {
  afterEach(() => {
    openPreviewLink.mockClear().mockReturnValue(true)
  })

  it('turns a bare URL into a link and leaves the prose as text', () => {
    const { container } = render(
      <UserMessage sessionId="s1" content={'把 http://localhost:3000 的样式改一下'} />,
    )

    const link = screen.getByRole('link', { name: 'http://localhost:3000' })
    expect(link.getAttribute('href')).toBe('http://localhost:3000')
    expect(bubbleOf(container).textContent).toBe('把 http://localhost:3000 的样式改一下')
  })

  it('stops the href at CJK punctuation', () => {
    render(<UserMessage sessionId="s1" content={'看看 http://localhost:5173，是不是白屏'} />)

    const link = screen.getByRole('link', { name: 'http://localhost:5173' })
    expect(link.getAttribute('href')).toBe('http://localhost:5173')
  })

  it('routes the click through the shared preview-link handler', () => {
    render(<UserMessage sessionId="s1" content={'打开 http://localhost:3000'} />)

    fireEvent.click(screen.getByRole('link', { name: 'http://localhost:3000' }))
    expect(openPreviewLink).toHaveBeenCalledWith('http://localhost:3000', 's1')
  })

  it('falls back to the anchor default when there is no session', () => {
    render(<UserMessage content={'打开 http://localhost:3000'} />)

    const link = screen.getByRole('link', { name: 'http://localhost:3000' })
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noreferrer noopener')

    fireEvent.click(link)
    expect(openPreviewLink).not.toHaveBeenCalled()
  })

  // Prompts are literal text: linkifying must not smuggle in markdown parsing.
  it('does not render markdown syntax in the prompt', () => {
    const content = '改一下 **bold** 和 `code`，还有 # 标题 与 [x](y)'
    const { container } = render(<UserMessage sessionId="s1" content={content} />)

    const bubble = bubbleOf(container)
    expect(bubble.textContent).toBe(content)
    expect(bubble.querySelector('strong')).toBeNull()
    expect(bubble.querySelector('code')).toBeNull()
    expect(bubble.querySelector('h1')).toBeNull()
    expect(bubble.querySelectorAll('a')).toHaveLength(0)
  })

  it('preserves line breaks around a linkified URL', () => {
    const content = '第一行\n打开 http://localhost:3000\n第三行'
    const { container } = render(<UserMessage sessionId="s1" content={content} />)

    expect(bubbleOf(container).textContent).toBe(content)
    expect(screen.getByRole('link', { name: 'http://localhost:3000' })).toBeTruthy()
  })

  it('renders no link when the prompt has no URL', () => {
    const { container } = render(<UserMessage sessionId="s1" content={'把样式改一下'} />)
    expect(container.querySelectorAll('a')).toHaveLength(0)
  })
})

// v1.7.5（设计师规范 40d6d249）：服务端注入的「【系统】…」通知原先按 user 消息渲染
// （--color-surface-user-msg 米黄气泡 + 右对齐），与用户自己发言撞色 ⇒ 单列系统通知样式。
// 判定顺序：先协作卡（页脚正则）→ 再系统通知（首个非空行【系统】开头）→ 否则普通气泡。
describe('UserMessage system notice', () => {
  afterEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  const stripOf = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('[data-message-shell="system-notice"]')

  it('keeps the collaboration card when a collab footer hits the notice prefix (check order)', () => {
    // 协作页脚本身也以【系统】开头：只剩页脚一行时两条判定都会命中，
    // 必须由协作卡先返回，否则折叠卡被系统通知分支吞掉。
    const content = '【系统】任务 ID：123e4567-e89b-12d3-a456-426614174000；'
    const { container } = render(<UserMessage content={content} timestamp={Date.now()} />)

    expect(container.querySelector('[data-collab-notice]')).toBeTruthy()
    expect(stripOf(container)).toBeNull()
  })

  it('keeps the collaboration card when the body starts with prose and the footer hits the regex', () => {
    const content = [
      '你的角色：前端。请实现登录页。',
      '【系统】任务 ID：123e4567-e89b-12d3-a456-426614174000；',
    ].join('\n')
    const { container } = render(<UserMessage content={content} timestamp={Date.now()} />)

    expect(container.querySelector('[data-collab-notice]')).toBeTruthy()
    expect(stripOf(container)).toBeNull()
  })

  it('renders the system-notice strip instead of the user bubble for a 【系统】 notice', () => {
    const content = '【系统】你的角色：前端。任务 ID：123e4567-e89b-12d3-a456-426614174000；'
    const { container } = render(<UserMessage content={content} timestamp={Date.now()} sessionId="s1" />)

    const strip = stripOf(container)
    expect(strip).toBeTruthy()
    // 撞色根因：不再使用用户气泡底色 / 右对齐。
    expect(strip?.className).toContain('bg-[var(--color-info-container)]')
    expect(strip?.className).not.toContain('--color-surface-user-msg')
    expect(container.querySelector('[data-message-shell="user"]')).toBeNull()
    // 容器居中、内容自适应宽度带上限、无边框、圆角与内边距。
    expect(container.firstElementChild?.className).toContain('justify-center')
    expect(container.firstElementChild?.className).toContain('mb-5')
    expect(strip?.className).toContain('w-fit')
    expect(strip?.className).toContain('max-w-[85%]')
    expect(strip?.className).not.toContain('border')
    expect(strip?.className).toContain('rounded-[var(--radius-md)]')
    expect(strip?.className).toContain('px-3')
    expect(strip?.className).toContain('py-1.5')
    expect(strip?.className).toContain('text-[13px]')
    expect(strip?.className).toContain('text-[var(--color-on-info-container)]')
    // 正文 + 图标 + 时间戳。
    const body = strip?.querySelector<HTMLElement>('[data-message-body="system-notice"]')
    expect(body?.textContent).toBe(content)
    expect(body?.style.overflowWrap).toBe('anywhere')
    const icon = strip?.querySelector<HTMLElement>('.material-symbols-outlined')
    expect(icon?.textContent).toBe('info')
    expect(icon?.className).toContain('text-[var(--color-info)]')
    expect(strip?.textContent).toContain('just now')
  })

  it('still matches when the notice is preceded by blank lines', () => {
    const { container } = render(<UserMessage content={'\n\n【系统】在册主管 1 人'} timestamp={Date.now()} />)
    expect(stripOf(container)).toBeTruthy()
  })

  it('leaves ordinary user messages and mid-line 【系统】 text untouched', () => {
    const plain = render(<UserMessage content={'把样式改一下'} />)
    expect(plain.container.querySelector('[data-message-shell="user"]')).toBeTruthy()
    expect(stripOf(plain.container)).toBeNull()

    // 「【系统】」出现在行中（非行首）不算通知。
    const midLine = render(<UserMessage content={'请参考【系统】说明'} />)
    expect(midLine.container.querySelector('[data-message-shell="user"]')).toBeTruthy()
    expect(stripOf(midLine.container)).toBeNull()
  })
})
