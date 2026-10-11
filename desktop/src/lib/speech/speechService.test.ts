import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CANCEL_RESTART_DELAY_MS,
  SpeechService,
  detectSpeechScript,
  watchdogMsFor,
} from './speechService'
import { resolveVoice } from './speechVoice'

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

  it('有引擎但无中文 voice 仍可播（不隐藏、不报错）', () => {
    voices = [voice('fr-FR')]
    const service = new SpeechService()
    expect(service.canSpeak()).toBe(true)
    service.play('m1', ['你好。'])
    vi.advanceTimersByTime(CANCEL_RESTART_DELAY_MS)
    expect(spoken).toHaveLength(1)
    // 新口径（架构师方案 5b8efdef）：目标语言池空时退回**全 voice 池择优**，而不是把
    // voice 留空交给系统默认 —— 唯一可选的是 fr-FR，就用它读（仍旧不隐藏、不报错）。
    expect(spoken[0]!.voice).toEqual(voices[0])
  })

  it('detectSpeechScript：单一书写系统各一例（日/韩/中/英）', () => {
    expect(detectSpeechScript('こんにちは')).toBe('ja')
    expect(detectSpeechScript('カタカナ')).toBe('ja')
    expect(detectSpeechScript('안녕하세요')).toBe('ko')
    expect(detectSpeechScript('中文句子')).toBe('zh')
    expect(detectSpeechScript('plain ascii')).toBe('en')
  })

  it('detectSpeechScript：混排按字符数取多数（多数改变结果）', () => {
    // 汉字 3 : 假名 5 ⇒ 假名多 → ja
    expect(detectSpeechScript('你们好，こんにちは')).toBe('ja')
    // 假名 5 : 汉字 6 ⇒ 汉字多 → zh（「出现即选」会错判成 ja）
    expect(detectSpeechScript('こんにちは、你好你好你好')).toBe('zh')
    // 汉字 6 : 谚文 2 ⇒ 汉字多 → zh（「出现即选」会错判成 ko）
    expect(detectSpeechScript('你好世界你好，안녕')).toBe('zh')
    // 汉字 4 : 谚文 5 ⇒ 谚文多 → ko
    expect(detectSpeechScript('你好世界，안녕하세요')).toBe('ko')
  })

  it('detectSpeechScript：平局按 ja > ko > zh', () => {
    expect(detectSpeechScript('あ한中')).toBe('ja') // 假名 1 = 谚文 1 = 汉字 1
    expect(detectSpeechScript('한中')).toBe('ko') // 谚文 1 = 汉字 1
    expect(detectSpeechScript('あ한')).toBe('ja') // 假名 1 = 谚文 1
    expect(detectSpeechScript('中ああ')).toBe('ja')
  })

  it('resolveVoice（无存储值）：按书写系统挑音色（日/韩文不再被当中文读）', () => {
    const all = [voice('en-US'), voice('zh-CN'), voice('ja-JP'), voice('ko-KR')]
    expect(resolveVoice('こんにちは', all, '')?.lang).toBe('ja-JP')
    expect(resolveVoice('안녕하세요', all, '')?.lang).toBe('ko-KR')
    expect(resolveVoice('你好世界', all, '')?.lang).toBe('zh-CN')
    expect(resolveVoice('hello world', all, '')?.lang).toBe('en-US')
    // 混排跟多数走：假名多 → ja，汉字多 → zh。
    expect(resolveVoice('你们好，こんにちは', all, '')?.lang).toBe('ja-JP')
    expect(resolveVoice('こんにちは、你好你好你好', all, '')?.lang).toBe('zh-CN')
  })

  it('resolveVoice：zh 池内 zh-CN 胜 zh-TW', () => {
    expect(resolveVoice('你好', [voice('zh-TW'), voice('zh-CN')], '')?.lang).toBe('zh-CN')
    expect(resolveVoice('你好', [voice('en-US'), voice('zh-TW')], '')?.lang).toBe('zh-TW')
  })

  it('resolveVoice：池空 ⇒ 退回全 voice 池择优；voices 全空 ⇒ null（系统默认）', () => {
    // 新口径（架构师方案）：目标语言缺 voice 不再直接放弃，而是全池打分 —— 有引擎就
    // 尽量读出来，而不是甩给系统默认（默认往往就是这条 en voice）。
    expect(resolveVoice('こんにちは', [voice('en-US'), voice('zh-CN')], '')?.lang).toBe('en-US')
    expect(resolveVoice('안녕하세요', [voice('zh-CN')], '')?.lang).toBe('zh-CN')
    expect(resolveVoice('hello', [], '')).toBeNull()
  })

  it('resolveVoice：存储值命中优先于择优；未命中不报错、回落择优', () => {
    const all = [
      voice('en-US'),
      voice('zh-CN'),
      { ...voice('ja-JP'), voiceURI: 'voice-of-my-choice' } as SpeechSynthesisVoice,
    ]
    expect(resolveVoice('hello', all, 'voice-of-my-choice')?.lang).toBe('ja-JP')
    expect(resolveVoice('hello', all, 'gone-uri')?.lang).toBe('en-US')
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

  it('看门狗跳段前必须先 cancel：否则新段排队等待 ⇒ 余下段级联静默', () => {
    // 排队制模型：speak 只入队；当前项未结束（本例永不 onend）就不播下一项；cancel 清队。
    const queue: FakeUtterance[] = []
    let current: FakeUtterance | null = null
    const played: string[] = []
    const pump = () => {
      if (current !== null) return
      const next = queue.shift()
      if (!next) return
      current = next
      played.push(next.text)
    }
    ;(window as unknown as { speechSynthesis?: unknown }).speechSynthesis = {
      speak: (utterance: FakeUtterance) => {
        queue.push(utterance)
        pump()
      },
      cancel: () => {
        queue.length = 0
        current = null
      },
      getVoices: () => voices,
      addEventListener: vi.fn(),
    }

    const service = new SpeechService()
    service.play('m1', ['S1', 'S2', 'S3'])
    vi.advanceTimersByTime(CANCEL_RESTART_DELAY_MS)
    expect(played).toEqual(['S1']) // S1 既无 onend 又仍占着引擎当前项

    vi.advanceTimersByTime(watchdogMsFor('S1', 1))
    // 看门狗若不先 cancel，S2 只会进队等待、played 停在 ['S1']——正是被修的级联静默。
    expect(played).toEqual(['S1', 'S2'])

    // 后续段同样能继续推进（不是只救回一段）。
    vi.advanceTimersByTime(watchdogMsFor('S2', 1))
    expect(played).toEqual(['S1', 'S2', 'S3'])
    expect(service.getSnapshot().status).toBe('speaking')
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

describe('speechService 音色接线', () => {
  it('消息朗读用 resolveVoice 解析出的音色：存储命中压过择优', () => {
    const natural = {
      ...voice('zh-CN', 'Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)'),
      voiceURI: 'uri-natural',
    } as SpeechSynthesisVoice
    const huihui = { ...voice('zh-CN', 'Microsoft Huihui'), voiceURI: 'uri-huihui' } as SpeechSynthesisVoice
    voices = [natural, huihui]

    const picked = new SpeechService()
    picked.play('m1', ['你好。'])
    vi.advanceTimersByTime(CANCEL_RESTART_DELAY_MS)
    expect(spoken[0]!.voice).toEqual(natural) // 未选：择优（Natural）

    spoken = []
    const chosen = new SpeechService()
    chosen.setVoiceURI('uri-huihui')
    chosen.play('m1', ['你好。'])
    vi.advanceTimersByTime(CANCEL_RESTART_DELAY_MS)
    expect(spoken[0]!.voice).toEqual(huihui) // 已选：命中即用
  })
})

describe('speechService 试听', () => {
  it('消息在播时试听：先暂停消息，试听完 resume 续播原消息', () => {
    const service = new SpeechService()
    service.play('m1', ['第一句。', '第二句。'])
    vi.advanceTimersByTime(CANCEL_RESTART_DELAY_MS)
    expect(spoken.map((u) => u.text)).toEqual(['第一句。'])

    service.preview('试听句。', '')
    expect(service.getSnapshot().status).toBe('paused')
    expect(service.getSnapshot().previewing).toBe(true)
    vi.advanceTimersByTime(CANCEL_RESTART_DELAY_MS)
    const preview = spoken[spoken.length - 1]!
    expect(preview.text).toBe('试听句。')

    preview.onend?.()
    expect(service.getSnapshot().previewing).toBe(false)
    expect(service.getSnapshot().previewVoiceURI).toBeNull()
    // 回到 speaking 并从**记住的段索引**续播（不是从头）。
    expect(service.getSnapshot().status).toBe('speaking')
    vi.advanceTimersByTime(CANCEL_RESTART_DELAY_MS)
    expect(spoken.map((u) => u.text)).toEqual(['第一句。', '试听句。', '第一句。'])
  })

  it('previewing 期间重复 preview 被拒（防重入）', () => {
    const service = new SpeechService()
    service.preview('试听句。', '')
    vi.advanceTimersByTime(CANCEL_RESTART_DELAY_MS)
    const dispatched = spoken.length
    service.preview('另一句。', '')
    vi.advanceTimersByTime(CANCEL_RESTART_DELAY_MS)
    expect(spoken.length).toBe(dispatched)
  })

  it('试听命中传入 voiceURI；空闲时试听不动消息状态', () => {
    const a = { ...voice('zh-CN', 'A'), voiceURI: 'uri-a' } as SpeechSynthesisVoice
    const b = { ...voice('zh-CN', 'B'), voiceURI: 'uri-b' } as SpeechSynthesisVoice
    voices = [a, b]
    const service = new SpeechService()
    expect(service.getSnapshot().status).toBe('idle')

    service.preview('试听句。', 'uri-b')
    expect(service.getSnapshot().previewVoiceURI).toBe('uri-b')
    vi.advanceTimersByTime(CANCEL_RESTART_DELAY_MS)
    expect(spoken[0]!.voice).toEqual(b)

    service.stopPreview()
    expect(service.getSnapshot().previewing).toBe(false)
    // 空闲起手的试听结束后不产生「续播」——状态仍是 idle，消息没有被误启动。
    expect(service.getSnapshot().status).toBe('idle')
  })

  it('试听期间 stop() 一并收尾（previewing 不残留）', () => {
    const service = new SpeechService()
    service.preview('试听句。', '')
    service.stop()
    expect(service.getSnapshot().previewing).toBe(false)
    expect(service.getSnapshot().previewVoiceURI).toBeNull()
  })
})
