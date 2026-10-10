import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'

import { MessageActionBar } from './MessageActionBar'
import { useSettingsStore } from '../../stores/settingsStore'
import { speechService } from '../../lib/speech/speechService'

class StubUtterance {
  text: string
  rate = 1
  voice: unknown = null
  onend: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(text: string) {
    this.text = text
  }
}

let voices: Array<{ lang: string; name: string }> = []

function installEngine() {
  ;(window as unknown as { speechSynthesis?: unknown }).speechSynthesis = {
    speak: vi.fn(),
    cancel: vi.fn(),
    getVoices: () => voices,
    addEventListener: vi.fn(),
  }
  ;(globalThis as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance =
    StubUtterance
}

function removeEngine() {
  delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis
  delete (globalThis as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance
}

beforeEach(() => {
  useSettingsStore.setState({ locale: 'zh', speechRate: 1 })
  voices = [{ lang: 'zh-CN', name: 'zh' }]
  speechService.stop()
})

afterEach(() => {
  // 组件可能仍挂着订阅：复位单例要包在 act 里，否则 stop() 的通知会打 React 警告。
  act(() => {
    speechService.stop()
  })
  removeEngine()
})

describe('MessageActionBar 朗读键（渲染与降级）', () => {
  it('引擎缺失 ⇒ 喇叭不渲染（复制键仍在）', () => {
    removeEngine()
    render(<MessageActionBar copyText="一条消息。" copyLabel="复制" messageId="m1" />)
    expect(screen.queryByLabelText('朗读本条消息')).toBeNull()
    expect(screen.getByLabelText('复制')).toBeTruthy()
  })

  it('voices 恒空 ⇒ 喇叭不渲染', () => {
    installEngine()
    voices = []
    render(<MessageActionBar copyText="一条消息。" copyLabel="复制" messageId="m1" />)
    expect(screen.queryByLabelText('朗读本条消息')).toBeNull()
  })

  it('没有可读文本（纯图消息）⇒ 喇叭不渲染', () => {
    installEngine()
    render(<MessageActionBar copyText="![图](/tmp/a.png)" copyLabel="复制" messageId="m1" />)
    expect(screen.queryByLabelText('朗读本条消息')).toBeNull()
  })

  it('有引擎与 voice 时渲染 idle 喇叭，三态标签依次切换并播报事件', () => {
    installEngine()
    render(<MessageActionBar copyText="第一句。第二句。" copyLabel="复制" messageId="m1" />)

    const idleChip = screen.getByLabelText('朗读本条消息')
    expect(idleChip).toBeTruthy()

    act(() => idleChip.click())
    expect(screen.getByLabelText('暂停朗读')).toBeTruthy()
    expect(screen.getByText('开始朗读')).toBeTruthy()

    act(() => screen.getByLabelText('暂停朗读').click())
    expect(screen.getByLabelText('继续朗读')).toBeTruthy()
    expect(screen.getByText('已暂停')).toBeTruthy()

    act(() => screen.getByLabelText('继续朗读').click())
    expect(screen.getByLabelText('暂停朗读')).toBeTruthy()
    expect(screen.getByText('已继续朗读')).toBeTruthy()
  })

  it('点另一条消息＝停旧读新，绑定与按钮态同步转移', () => {
    installEngine()
    render(
      <>
        <MessageActionBar copyText="第一条消息。" copyLabel="复制" messageId="m1" />
        <MessageActionBar copyText="第二条消息。" copyLabel="复制" messageId="m2" />
      </>,
    )

    act(() => screen.getAllByLabelText('朗读本条消息')[0]!.click())
    expect(screen.getAllByLabelText('朗读本条消息')).toHaveLength(1)
    expect(screen.getByLabelText('暂停朗读')).toBeTruthy()

    act(() => screen.getByLabelText('朗读本条消息').click())
    // 旧消息回到 idle，新消息接手为 speaking：始终只有一个「暂停朗读」。
    expect(screen.getAllByLabelText('暂停朗读')).toHaveLength(1)
    expect(screen.getAllByLabelText('朗读本条消息')).toHaveLength(1)
  })

  it('超长文本被截断时，朗读中出现轻提示', () => {
    installEngine()
    render(<MessageActionBar copyText={'甲'.repeat(5001)} copyLabel="复制" messageId="m1" />)
    expect(screen.queryByText('内容较长，仅朗读前一部分')).toBeNull()

    act(() => screen.getByLabelText('朗读本条消息').click())
    expect(screen.getByText('内容较长，仅朗读前一部分')).toBeTruthy()
  })
})
