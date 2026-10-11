import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

import { SpeechSettingsSection } from './SpeechSettingsSection'
import { useSettingsStore } from '../../stores/settingsStore'
import { VOICE_LOAD_GRACE_MS } from '../../lib/speech/useSpeechVoices'
import { SPEECH_VOICE_STORAGE_KEY } from '../../lib/speech/speechVoice'
import { speechService } from '../../lib/speech/speechService'

type StubVoice = {
  name: string
  lang: string
  voiceURI: string
  localService: boolean
  default: boolean
}

function stubVoice(input: StubVoice): SpeechSynthesisVoice {
  return input as unknown as SpeechSynthesisVoice
}

const ZH_NATURAL = stubVoice({
  name: 'Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)',
  lang: 'zh-CN',
  voiceURI: 'uri-zh-natural',
  localService: false,
  default: false,
})
const ZH_HUIHUI = stubVoice({
  name: 'Microsoft Huihui - Chinese (Simplified)',
  lang: 'zh-CN',
  voiceURI: 'uri-zh-huihui',
  localService: true,
  default: false,
})
const EN_ARIA = stubVoice({
  name: 'Microsoft Aria Online (Natural) - English (United States)',
  lang: 'en-US',
  voiceURI: 'uri-en-aria',
  localService: false,
  default: true,
})

let voices: SpeechSynthesisVoice[] = []
let voicesChangedListener: (() => void) | null = null

function installEngine(list: SpeechSynthesisVoice[]) {
  voices = list
  ;(window as unknown as { speechSynthesis?: unknown }).speechSynthesis = {
    speak: vi.fn(),
    cancel: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    getVoices: () => voices,
    addEventListener: (type: string, listener: () => void) => {
      if (type === 'voiceschanged') voicesChangedListener = listener
    },
    removeEventListener: vi.fn(),
  }
  ;(globalThis as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance =
    class {
      text: string
      rate = 1
      voice: unknown = null
      onend: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor(text: string) {
        this.text = text
      }
    }
}

function removeEngine() {
  delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis
  delete (globalThis as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance
  voicesChangedListener = null
}

beforeEach(() => {
  useSettingsStore.setState({ locale: 'zh', speechRate: 1, speechVoiceURI: '' })
})

afterEach(() => {
  cleanup()
  removeEngine()
  vi.useRealTimers()
})

describe('SpeechSettingsSection 降级', () => {
  it('无 speechSynthesis ⇒ 整个朗读 section 不渲染（含语速组）', () => {
    removeEngine()
    render(<SpeechSettingsSection />)
    expect(screen.queryByText('音色')).not.toBeInTheDocument()
    expect(screen.queryByText('语速')).not.toBeInTheDocument()
    expect(screen.queryByText('0.75×')).not.toBeInTheDocument()
  })

  it('voices 读取中 ⇒ 一行「正在读取系统语音…」，宽限过后转空态', () => {
    vi.useFakeTimers()
    installEngine([])
    render(<SpeechSettingsSection />)
    expect(screen.getByTestId('speech-voice-loading')).toHaveTextContent('正在读取系统语音…')
    act(() => {
      vi.advanceTimersByTime(VOICE_LOAD_GRACE_MS)
    })
    expect(screen.queryByTestId('speech-voice-loading')).not.toBeInTheDocument()
    expect(screen.getByTestId('speech-voice-empty')).toBeDisabled()
    expect(screen.getByTestId('speech-voice-empty')).toHaveTextContent('未检测到可用语音')
  })

  it('voices=1 ⇒ 不渲染选择器，改静态说明 + 试听键', () => {
    installEngine([ZH_NATURAL])
    render(<SpeechSettingsSection />)
    expect(screen.queryByTestId('speech-voice-trigger')).not.toBeInTheDocument()
    expect(screen.getByTestId('speech-voice-single')).toHaveTextContent(
      '音色：Xiaoxiao · Chinese (Mainland)（系统唯一可用）',
    )
    expect(screen.getByTestId('speech-voice-preview-single')).toBeInTheDocument()
  })

  it('语速组随组件迁入（档位仍在，且改档写入 store）', () => {
    installEngine([ZH_NATURAL])
    render(<SpeechSettingsSection />)
    const rate = screen.getByRole('button', { name: '1.5×' })
    fireEvent.click(rate)
    expect(useSettingsStore.getState().speechRate).toBe(1.5)
  })
})

describe('SpeechSettingsSection 音色选择器', () => {
  it('首项为「自动（推荐）」+ 推荐徽标；分组按界面语言置顶（ZH · 2 在 EN · 1 之前）', () => {
    installEngine([EN_ARIA, ZH_NATURAL, ZH_HUIHUI])
    render(<SpeechSettingsSection />)
    fireEvent.click(screen.getByTestId('speech-voice-trigger'))

    const options = screen.getAllByRole('option')
    expect(options[0]).toHaveTextContent('自动（推荐）')
    expect(options[0]).toHaveTextContent('推荐')
    expect(options[1]).toHaveTextContent('Xiaoxiao · Chinese (Mainland)')
    expect(options[2]).toHaveTextContent('Huihui · Chinese (Simplified)')
    expect(options[3]).toHaveTextContent('Aria · English (United States)')

    const zhHeader = screen.getByText('ZH · 2')
    const enHeader = screen.getByText('EN · 1')
    // 置顶：ZH 组头必须出现在 EN 之前。
    expect(zhHeader.compareDocumentPosition(enHeader) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('选择音色后同步注入朗读服务（lib 不 import stores，由 store 推进去）', () => {
    act(() => useSettingsStore.getState().setSpeechVoiceURI('uri-zh-huihui'))
    expect(speechService.getVoiceURI()).toBe('uri-zh-huihui')
    act(() => useSettingsStore.getState().setSpeechVoiceURI(''))
    expect(speechService.getVoiceURI()).toBe('')
  })

  it('组内按择优分降序排列（乱序输入也排回来），且每组第一行带「推荐」徽标', () => {
    // 故意乱序：Huihui（-80）排在 Xiaoxiao Online (Natural)（+130）之前。
    installEngine([EN_ARIA, ZH_HUIHUI, ZH_NATURAL])
    render(<SpeechSettingsSection />)
    fireEvent.click(screen.getByTestId('speech-voice-trigger'))

    const options = screen.getAllByRole('option')
    // [0]=自动；[1..2]=ZH 组（降序后 Natural 在前）；[3]=EN 组首。
    expect(options[1]).toHaveTextContent('Xiaoxiao · Chinese (Mainland)')
    expect(options[2]).toHaveTextContent('Huihui · Chinese (Simplified)')
    // 组首带「推荐」，组内其余行不带。
    expect(options[1]).toHaveTextContent('推荐')
    expect(options[2]).not.toHaveTextContent('推荐')
    expect(options[3]).toHaveTextContent('Aria · English (United States)')
    expect(options[3]).toHaveTextContent('推荐')
  })

  it('副标题给原 lang 码与本地/在线徽标', () => {
    installEngine([ZH_HUIHUI, EN_ARIA])
    render(<SpeechSettingsSection />)
    fireEvent.click(screen.getByTestId('speech-voice-trigger'))
    const row = screen.getByRole('option', { name: /Huihui/ })
    expect(row).toHaveTextContent('zh-CN')
    expect(row).toHaveTextContent('本地')
  })

  it('选中态：当前值那行 aria-selected + Check 图标；点选后写回 store 与 localStorage', () => {
    installEngine([ZH_NATURAL, ZH_HUIHUI])
    render(<SpeechSettingsSection />)
    fireEvent.click(screen.getByTestId('speech-voice-trigger'))
    const huihui = screen.getByRole('option', { name: /Huihui/ })
    fireEvent.click(huihui)

    expect(useSettingsStore.getState().speechVoiceURI).toBe('uri-zh-huihui')
    expect(window.localStorage.getItem(SPEECH_VOICE_STORAGE_KEY)).toBe('uri-zh-huihui')
    // 弹层关闭、触发钮显示所选音色（清洗后的名字）。
    expect(screen.queryByTestId('speech-voice-popup')).not.toBeInTheDocument()
    expect(screen.getByTestId('speech-voice-trigger')).toHaveTextContent('Huihui · Chinese (Simplified)')

    fireEvent.click(screen.getByTestId('speech-voice-trigger'))
    expect(screen.getByRole('option', { name: /Huihui/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('option', { name: /Huihui/ }).querySelector('svg')).toBeTruthy()
  })

  it('打开焦点进搜索框；↑↓ roving、Enter 选中并关、Home/End 到两端', () => {
    installEngine([ZH_NATURAL, ZH_HUIHUI])
    render(<SpeechSettingsSection />)
    fireEvent.click(screen.getByTestId('speech-voice-trigger'))
    const search = screen.getByTestId('speech-voice-search')
    expect(document.activeElement).toBe(search)

    fireEvent.keyDown(search, { key: 'ArrowDown' })
    const options = screen.getAllByRole('option')
    expect(document.activeElement).toBe(options[1])

    fireEvent.keyDown(options[1]!, { key: 'End' })
    expect(document.activeElement).toBe(screen.getAllByRole('option')[2])

    fireEvent.keyDown(screen.getAllByRole('option')[2]!, { key: 'Home' })
    expect(document.activeElement).toBe(screen.getAllByRole('option')[0])

    fireEvent.keyDown(screen.getAllByRole('option')[0]!, { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getAllByRole('option')[1]!, { key: 'Enter' })
    expect(useSettingsStore.getState().speechVoiceURI).toBe('uri-zh-natural')
    expect(screen.queryByTestId('speech-voice-popup')).not.toBeInTheDocument()
    // 关闭后焦点归还触发钮。
    expect(document.activeElement).toBe(screen.getByTestId('speech-voice-trigger'))
  })

  it('Esc 关且不选中', () => {
    installEngine([ZH_NATURAL, ZH_HUIHUI])
    render(<SpeechSettingsSection />)
    fireEvent.click(screen.getByTestId('speech-voice-trigger'))
    fireEvent.keyDown(screen.getByTestId('speech-voice-search'), { key: 'Escape' })
    expect(screen.queryByTestId('speech-voice-popup')).not.toBeInTheDocument()
    expect(useSettingsStore.getState().speechVoiceURI).toBe('')
  })

  it('搜索按 name + lang 过滤；无匹配显示一行说明', () => {
    installEngine([ZH_NATURAL, EN_ARIA])
    render(<SpeechSettingsSection />)
    fireEvent.click(screen.getByTestId('speech-voice-trigger'))
    const search = screen.getByTestId('speech-voice-search')

    fireEvent.change(search, { target: { value: 'en-US' } })
    expect(screen.getByRole('option', { name: /Aria/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Xiaoxiao/ })).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'zzz-not-found' } })
    expect(screen.getByText('没有匹配的语音')).toBeInTheDocument()
    // 「自动」不受搜索影响（它不是系统 voice）。
    expect(screen.getByRole('option', { name: /自动/ })).toBeInTheDocument()
  })

  it('新增 voice（voiceschanged）后补进列表', () => {
    installEngine([ZH_NATURAL, EN_ARIA])
    render(<SpeechSettingsSection />)
    fireEvent.click(screen.getByTestId('speech-voice-trigger'))
    expect(screen.queryByRole('option', { name: /Huihui/ })).not.toBeInTheDocument()

    act(() => {
      voices = [ZH_NATURAL, ZH_HUIHUI, EN_ARIA]
      voicesChangedListener?.()
    })
    expect(screen.getByRole('option', { name: /Huihui/ })).toBeInTheDocument()
  })
})
