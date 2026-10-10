import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CANCEL_RESTART_DELAY_MS,
  SpeechService,
  containsCjk,
  pickVoice,
  watchdogMsFor,
} from './speechService'

type FakeUtterance = {
  text: string
  rate: number
  voice: unknown
  onend: (() => void) | null
  onerror: (() => void) | null
}

let spoken: FakeUtterance[] = []
let order: string[] = []
let voices: SpeechSynthesisVoice[] = []

function voice(lang: string, name = lang): SpeechSynthesisVoice {
  return { lang, name } as unknown as SpeechSynthesisVoice
}

function installEngine(options: { canSpeak?: boolean } = {}) {
  const synth = {
    cancel: vi.fn(() => {
      order.push('cancel')
    }),
    getVoices: vi.fn(() => voices),
    addEventListener: vi.fn(),
    speak: vi.fn((utterance: FakeUtterance) => {
      order.push(`speak:${utterance.text}`)
      spoken.push(utterance)
    }),
  }
  ;(window as unknown as { speechSynthesis?: unknown }).speechSynthesis = options.canSpeak === false
    ? synth
    : synth
  return synth
}

class FakeSpeechSynthesisUtterance implements FakeUtterance {
  text: string
  rate = 1
  voice: unknown = null
  onend: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(text: string) {
    this.text = text
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  spoken = []
  order = []
  voices = [voice('zh-CN'), voice('en-US')]
  ;(globalThis as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance =
    FakeSpeechSynthesisUtterance
  installEngine()
})

afterEach(() => {
  vi.useRealTimers()
  delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis
  delete (globalThis as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance
})

describe('speechService 可用性与降级', () => {
  it('引擎缺失 ⇒ canSpeak 为假，play 不派发', () => {
    delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis
    const service = new SpeechService()
    expect(service.canSpeak()).toBe(false)
    service.play('m1', ['一句话。'])
    vi.advanceTimersByTime(CANCEL_RESTART_DELAY_MS * 2)
    expect(spoken).toEqual([])
    expect(service.getSnapshot().status).toBe('idle')
  })

  it('voices 恒空 ⇒ canSpeak 为假（喇叭不渲染的依据）', () => {
    voices = []
    const service = new SpeechService()
    expect(service.canSpeak()).toBe(false)
  })

  it('有引擎无中文 voice 仍可播（用默认 voice，不隐藏）', () => {
    voices = [voice('fr-FR')]
    const service = new SpeechService()
    expect(service.canSpeak()).toBe(true)
    service.play('m1', ['你好。'])
    vi.advanceTimersByTime(CANCEL_RESTART_DELAY_MS)
    expect(spoken).toHaveLength(1)
    expect(spoken[0]!.voice).toBeNull()
  })

  it('pickVoice：含 CJK 挑 zh，否则挑 en，挑不到为 null', () => {
    expect(pickVoice('你好世界', [voice('en-US')])).toBeNull()
    expect(pickVoice('你好世界', [voice('en-US'), voice('zh-CN')])?.lang).toBe('zh-CN')
    expect(pickVoice('hello world', [voice('zh-CN'), voice('en-GB')])?.lang).toBe('en-GB')
    expect(pickVoice('hello', [])).toBeNull()
  })

  it('containsCjk：中日韩为真，英文为假', () => {
    expect(containsCjk('中文')).toBe(true)
    expect(containsCjk('かな')).toBe(true)
    expect(containsCjk('한글')).toBe(true)
    expect(containsCjk('plain ascii')).toBe(false)
  })
})

describe('speechService 状态机', () => {
  it('play 延迟 ~50ms 才派发首句（防 Windows 丢首句）', () => {
    const service = new SpeechService()
    service.play('m1', ['第一句。'])
    expect(spoken).toEqual([])
    vi.advanceTimersByTime(CANCEL_RESTART_DELAY_MS)
    expect(spoken.map((u) => u.text)).toEqual(['第一句。'])
  })

  it('互斥：play(B) 先 cancel 旧队列再入队 B，绑定同步转移', () => {
    const service = new SpeechService()
    service.play('m1', ['A1'])
    vi.advanceTimersByTime(CANCEL_RESTART_DELAY_MS)
    service.play('m2', ['B1'])
    vi.advanceTimersByTime(CANCEL_RESTART_DELAY_MS)
    // 每次 play 都先 cancel（含首次，清残留）；关键顺序是 B 的 cancel 在 B 的 speak 之前。
    expect(order).toEqual(['cancel', 'speak:A1', 'cancel', 'speak:B1'])
    expect(service.getSnapshot().currentMessageId).toBe('m2')
    expect(service.getSnapshot().status).toBe('speaking')
  })

  it('暂停＝停派发并记索引；继续＝从该索引重 speak', () => {
    const service = new SpeechService()
    service.play('m1', ['S1', 'S2'])
    vi.advanceTimersByTime(CANCEL_RESTART_DELAY_MS)
    expect(spoken.map((u) => u.text)).toEqual(['S1'])

    service.pause()
    expect(service.getSnapshot().status).toBe('paused')
    const dispatchedAtPause = spoken.length
    // 推进到看门狗窗口之外：暂停期间既不能续段，也不能被看门狗顶出下一段。
    vi.advanceTimersByTime(watchdogMsFor('S1', 1) + 5000)
    expect(spoken.length).toBe(dispatchedAtPause)

    service.resume()
    vi.advanceTimersByTime(CANCEL_RESTART_DELAY_MS)
    expect(service.getSnapshot().status).toBe('speaking')
    expect(spoken.map((u) => u.text)).toEqual(['S1', 'S1'])
  })

  it('一段结束自动续下一段，末段结束回到 idle 并清绑定', () => {
    const service = new SpeechService()
    service.play('m1', ['S1', 'S2'])
    vi.advanceTimersByTime(CANCEL_RESTART_DELAY_MS)
    spoken[spoken.length - 1]!.onend?.()
    expect(spoken.map((u) => u.text)).toEqual(['S1', 'S2'])
    spoken[spoken.length - 1]!.onend?.()
    expect(service.getSnapshot().status).toBe('idle')
    expect(service.getSnapshot().currentMessageId).toBeNull()
  })

  it('变速：按新 rate 从当前段索引重建队列续播', () => {
    const service = new SpeechService()
    service.play('m1', ['S1', 'S2'], 1)
    vi.advanceTimersByTime(CANCEL_RESTART_DELAY_MS)
    expect(spoken[0]!.rate).toBe(1)

    service.setRate(1.5)
    vi.advanceTimersByTime(CANCEL_RESTART_DELAY_MS)
    expect(spoken).toHaveLength(2)
    expect(spoken[1]!.text).toBe('S1')
    expect(spoken[1]!.rate).toBe(1.5)
    expect(service.getSnapshot().rate).toBe(1.5)
    expect(service.getSnapshot().status).toBe('speaking')
  })

  it('看门狗：段超时未 onend ⇒ 跳到下一段', () => {
    const service = new SpeechService()
    service.play('m1', ['S1', 'S2'])
    vi.advanceTimersByTime(CANCEL_RESTART_DELAY_MS)
    expect(spoken.map((u) => u.text)).toEqual(['S1'])
    vi.advanceTimersByTime(watchdogMsFor('S1', 1))
    expect(spoken.map((u) => u.text)).toEqual(['S1', 'S2'])
  })

  it('旧 utterance 的迟到回调被归属校验丢弃（不误跳段）', () => {
    const service = new SpeechService()
    service.play('m1', ['S1', 'S2'])
    vi.advanceTimersByTime(CANCEL_RESTART_DELAY_MS)
    const stale = spoken[0]!
    service.play('m2', ['B1'])
    stale.onend?.()
    vi.advanceTimersByTime(CANCEL_RESTART_DELAY_MS)
    expect(spoken.map((u) => u.text)).toEqual(['S1', 'B1'])
    expect(service.getSnapshot().currentMessageId).toBe('m2')
  })

  it('stop：复位为 idle 并取消引擎', () => {
    const service = new SpeechService()
    service.play('m1', ['S1'])
    vi.advanceTimersByTime(CANCEL_RESTART_DELAY_MS)
    service.stop()
    expect(service.getSnapshot().status).toBe('idle')
    expect(service.getSnapshot().currentMessageId).toBeNull()
    vi.advanceTimersByTime(5000)
    expect(spoken.map((u) => u.text)).toEqual(['S1'])
  })

  it('空段列表不启动朗读', () => {
    const service = new SpeechService()
    service.play('m1', [])
    vi.advanceTimersByTime(CANCEL_RESTART_DELAY_MS * 2)
    expect(spoken).toEqual([])
    expect(service.getSnapshot().status).toBe('idle')
  })

  it('订阅者在状态变化时收到新快照', () => {
    const service = new SpeechService()
    const seen: string[] = []
    const unsubscribe = service.subscribe((snapshot) => seen.push(snapshot.status))
    service.play('m1', ['S1'])
    expect(seen).toEqual(['speaking'])
    service.pause()
    expect(seen).toEqual(['speaking', 'paused'])
    unsubscribe()
    service.resume()
    expect(seen).toEqual(['speaking', 'paused'])
  })
})
