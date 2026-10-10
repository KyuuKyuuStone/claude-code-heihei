import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'

import { InjectedCollabCard, type CollabNotice } from './InjectedCollabCard'
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

const NOTICE: CollabNotice = {
  kind: 'dispatch',
  taskId: '174ea826-07b7-46cf-b0c3-6a58a0c69a79',
  role: '前端',
  summary: 'TTS 消息朗读',
}

function installEngine() {
  ;(window as unknown as { speechSynthesis?: unknown }).speechSynthesis = {
    speak: vi.fn(),
    cancel: vi.fn(),
    getVoices: () => [{ lang: 'zh-CN', name: 'zh' }],
    addEventListener: vi.fn(),
  }
  ;(globalThis as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance =
    StubUtterance
}

function renderCard() {
  return render(
    <InjectedCollabCard notice={NOTICE} content="派活正文。" messageId="m1">
      <div>派活正文。</div>
    </InjectedCollabCard>,
  )
}

const cardClass = () => (document.querySelector('[data-collab-notice]') as HTMLElement).className

beforeEach(() => {
  useSettingsStore.setState({ locale: 'zh', speechRate: 1 })
  installEngine()
  speechService.stop()
})

afterEach(() => {
  act(() => {
    speechService.stop()
  })
  delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis
  delete (globalThis as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance
})

describe('协作卡朗读描边', () => {
  it('左缘是常驻身份条、朗读态描边走右缘（不复用左缘）', () => {
    renderCard()
    // 身份条常驻（身份 = 左缘 3px brand）。
    expect(document.querySelector('[data-collab-notice] span')?.className).toContain('left-0')
    expect(cardClass()).not.toContain('shadow-[inset')

    act(() => {
      speechService.play('m1', ['派活正文。'], 1)
    })
    expect(cardClass()).toContain('shadow-[inset_-3px_0_0_var(--color-brand)]')
    // 旧实现用的左缘描边与本卡身份条完全重合（零视觉变化），不得再用。
    expect(cardClass()).not.toContain('shadow-[inset_3px_0_0')
  })

  it('暂停态保留右缘描边', () => {
    renderCard()
    act(() => {
      speechService.play('m1', ['派活正文。'], 1)
    })
    act(() => {
      speechService.pause()
    })
    expect(speechService.getSnapshot().status).toBe('paused')
    expect(cardClass()).toContain('shadow-[inset_-3px_0_0_var(--color-brand)]')
  })

  it('未朗读时不描边', () => {
    renderCard()
    expect(cardClass()).not.toContain('shadow-[inset')
  })
})
