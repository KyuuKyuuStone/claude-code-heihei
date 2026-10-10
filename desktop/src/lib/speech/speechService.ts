/**
 * speechService —— 消息朗读（TTS）引擎封装：模块级单例 + 自管分段队列 + 状态机。
 *
 * 引擎 = 系统内置 `window.speechSynthesis`（不引入任何第三方 TTS 依赖）。
 *
 * 硬口径（设计裁定 §2/§4）：
 *   · 单例：同一时刻只读一条消息 ⇒ `play(新消息)` 先取消旧队列再起新队列，天然互斥。
 *   · 不用原生 pause()/resume()（平台不可靠）：暂停 = 停派发并记住段索引；继续 = 从该索引重 speak。
 *   · cancel() 后延迟 CANCEL_RESTART_DELAY_MS 再 speak（Windows/Chromium 立即派发会丢首句）。
 *   · 变速 = 记住当前段索引、按新 rate 重建队列续播（rate 是 utterance 属性，改旧队列无效）。
 *   · 看门狗：某段超时未收到 onend ⇒ 跳到下一段（防长段静默中断后整条卡死）。
 *   · voices 异步：模块加载预热一次 + 挂 voiceschanged 刷新；每次 speak 前惰性重取。
 *   · 降级：引擎不存在或 voices 恒空 ⇒ canSpeak() false ⇒ 调用方不渲染喇叭。
 *     有引擎但无中文 voice ⇒ 不隐藏，用默认 voice 读。
 *
 * 依赖纪律：本模块属 lib 层，不 import components/ 与 stores/（语速由调用方经
 * setRate / play 传入）。
 */

import { SPEECH_RATE_DEFAULT, normalizeSpeechRate } from './speechRate'

/** cancel 后到下一次派发的间隔（防 Windows 丢首句）。 */
export const CANCEL_RESTART_DELAY_MS = 50

/** 看门狗基础时长（每段至少给这么久）。 */
export const SPEECH_WATCHDOG_BASE_MS = 5000

/** 看门狗每字增量（≈11 字/秒的保守朗读速度）。 */
export const SPEECH_WATCHDOG_PER_CHAR_MS = 90

export type SpeechStatus = 'idle' | 'speaking' | 'paused'

export type SpeechSnapshot = {
  status: SpeechStatus
  /** 当前正在（或暂停于）朗读的消息 id；idle 时为 null。 */
  currentMessageId: string | null
  rate: number
  /** 引擎可用且已有 voice ⇒ 调用方才渲染喇叭键。 */
  canSpeak: boolean
}

type SynthLike = {
  speak: (utterance: SpeechSynthesisUtterance) => void
  cancel: () => void
  getVoices: () => SpeechSynthesisVoice[]
  addEventListener?: (type: string, listener: () => void) => void
}

type UtteranceCtor = new (text: string) => SpeechSynthesisUtterance

function getSynth(): SynthLike | null {
  if (typeof window === 'undefined') return null
  const candidate = (window as unknown as { speechSynthesis?: Partial<SynthLike> }).speechSynthesis
  if (!candidate || typeof candidate.speak !== 'function' || typeof candidate.cancel !== 'function') {
    return null
  }
  if (typeof candidate.getVoices !== 'function') return null
  return candidate as SynthLike
}

function getUtteranceCtor(): UtteranceCtor | null {
  const ctor = (globalThis as unknown as { SpeechSynthesisUtterance?: UtteranceCtor })
    .SpeechSynthesisUtterance
  return typeof ctor === 'function' ? ctor : null
}

/** 朗读文本所属的书写系统（决定挑哪个语言的 voice）。 */
export type SpeechScript = 'ja' | 'ko' | 'zh' | 'en'

/** 假名（平假名/片假名）。 */
const KANA_RE = /[\u3040-\u309f\u30a0-\u30ff]/
/** 谚文（jamo + 兼容字母 + 音节）。 */
const HANGUL_RE = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/
/** 汉字（扩展 A + 基本区 + 兼容表意）。 */
const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/**
 * 按书写系统分流：含假名 → ja；含谚文 → ko；否则含汉字 → zh；其余 → en。
 *
 * 取代旧口径「CJK 一律按 zh」——假名/谚文被当成中文会让 ja/ko voice 挑成 zh，
 * 读出来是错的（日文汉字与韩文汉字词虽同源，但整句读法不同）。
 * 混排优先级：假名 > 谚文 > 汉字（`你好、こんにちは` 走 ja）。
 */
export function detectSpeechScript(text: string): SpeechScript {
  if (KANA_RE.test(text)) return 'ja'
  if (HANGUL_RE.test(text)) return 'ko'
  if (HAN_RE.test(text)) return 'zh'
  return 'en'
}

/**
 * 按文本书写系统挑 voice；目标语言 voice 不存在（含只有引擎没有该语种）返回 null
 * ⇒ 用系统默认 voice 读（不隐藏喇叭、不报错）。
 */
export function pickVoice(
  text: string,
  voices: readonly SpeechSynthesisVoice[],
): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null
  const script = detectSpeechScript(text)
  const langOf = (voice: SpeechSynthesisVoice) => voice.lang ?? ''
  if (script === 'zh') {
    // 简体优先：zh-CN 优先，其次任意 zh（zh-TW / zh-HK 等）。
    return voices.find((voice) => /^zh-CN/i.test(langOf(voice)))
      ?? voices.find((voice) => /^zh/i.test(langOf(voice)))
      ?? null
  }
  const prefix = script === 'ja' ? /^ja/i : script === 'ko' ? /^ko/i : /^en/i
  return voices.find((voice) => prefix.test(langOf(voice))) ?? null
}

/** 单段看门狗时长：基础 + 每字增量，再按 rate 放大（慢速朗读耗时更长）。 */
export function watchdogMsFor(segment: string, rate: number): number {
  const safeRate = rate > 0 ? rate : SPEECH_RATE_DEFAULT
  return Math.round((SPEECH_WATCHDOG_BASE_MS + segment.length * SPEECH_WATCHDOG_PER_CHAR_MS) / safeRate)
}

export class SpeechService {
  private listeners = new Set<(snapshot: SpeechSnapshot) => void>()
  private status: SpeechStatus = 'idle'
  private currentMessageId: string | null = null
  private segments: string[] = []
  private index = 0
  private rate = SPEECH_RATE_DEFAULT
  private utterance: SpeechSynthesisUtterance | null = null
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null
  private startTimer: ReturnType<typeof setTimeout> | null = null
  private voicesBound = false
  /** null = 尚未拿到任何 voice（此后每次重取）；非 null = 已缓存，仅 voiceschanged 刷新。 */
  private voiceCache: SpeechSynthesisVoice[] | null = null
  private snapshot: SpeechSnapshot = {
    status: 'idle',
    currentMessageId: null,
    rate: SPEECH_RATE_DEFAULT,
    canSpeak: false,
  }

  /** 模块加载预热：读一次 voices（促使引擎初始化）并挂上 voiceschanged。 */
  warmUp = (): void => {
    const synth = getSynth()
    if (!synth) return
    this.bindVoicesChanged(synth)
    this.voiceCache = null
    this.rebuildSnapshot()
  }

  subscribe = (listener: (snapshot: SpeechSnapshot) => void): (() => void) => {
    this.listeners.add(listener)
    const synth = getSynth()
    if (synth) this.bindVoicesChanged(synth)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): SpeechSnapshot => {
    // canSpeak 会随 voices 异步就绪而翻转（无事件时也如此）：渲染期做一次廉价核对，
    // 变了就重建快照对象（不变则返回同一个引用，useSyncExternalStore 不会空转）。
    if (this.canSpeak() !== this.snapshot.canSpeak) this.rebuildSnapshot()
    return this.snapshot
  }

  /**
   * 引擎存在且已有 voice。
   *
   * voices 异步就绪：未拿到 voice 时每次惰性重取（防 Electron 版本差异 + 事件缺失），
   * 一旦拿到就缓存，只由 voiceschanged 刷新——否则虚拟列表里每条消息都会 getVoices()。
   */
  canSpeak = (): boolean => {
    const synth = getSynth()
    if (!synth) return false
    if (this.voiceCache === null) {
      const live = this.readVoices(synth)
      if (live.length > 0) this.voiceCache = live
      return live.length > 0
    }
    return this.voiceCache.length > 0
  }

  isSpeaking = (): boolean => this.status !== 'idle'

  getRate = (): number => this.rate

  play(messageId: string, segments: string[], rate?: number): void {
    if (segments.length === 0) return
    if (!this.canSpeak()) return
    this.cancelEngine()
    this.clearTimers()
    this.currentMessageId = messageId
    this.segments = [...segments]
    this.index = 0
    if (typeof rate === 'number') this.rate = normalizeSpeechRate(rate)
    this.status = 'speaking'
    this.notify()
    this.scheduleStart()
  }

  pause(): void {
    if (this.status !== 'speaking') return
    this.clearTimers()
    this.cancelEngine()
    this.status = 'paused'
    this.notify()
  }

  resume(): void {
    if (this.status !== 'paused') return
    this.status = 'speaking'
    this.notify()
    this.scheduleStart()
  }

  /** 完全停止并复位（切换会话时调用；消息组件卸载**不**停）。 */
  stop(): void {
    if (this.status === 'idle' && this.currentMessageId === null) {
      this.clearTimers()
      this.cancelEngine()
      return
    }
    this.clearTimers()
    this.cancelEngine()
    this.status = 'idle'
    this.currentMessageId = null
    this.segments = []
    this.index = 0
    this.notify()
  }

  setRate(rate: number): void {
    const next = normalizeSpeechRate(rate)
    if (next === this.rate) return
    this.rate = next
    if (this.status === 'speaking') {
      // rate 只作用于 utterance 属性 ⇒ 取消当前段、从当前索引按新 rate 续播。
      this.clearWatchdog()
      this.cancelEngine()
      this.notify()
      this.scheduleStart()
      return
    }
    this.notify()
  }

  // ---------------------------------------------------------------- 内部

  private bindVoicesChanged(synth: SynthLike): void {
    if (this.voicesBound) return
    this.voicesBound = true
    try {
      synth.addEventListener?.('voiceschanged', () => {
        // 事件后清缓存重取（voice 列表可能整体替换），再通知订阅者重算 canSpeak。
        this.voiceCache = null
        this.notify()
      })
    } catch {
      // 引擎不支持事件：退化为「每次 speak 前惰性重取」。
    }
  }

  private readVoices(synth: SynthLike): SpeechSynthesisVoice[] {
    try {
      return synth.getVoices() ?? []
    } catch {
      return []
    }
  }

  private scheduleStart(): void {
    this.clearTimers()
    this.startTimer = setTimeout(() => {
      this.startTimer = null
      this.speakCurrentSegment()
    }, CANCEL_RESTART_DELAY_MS)
  }

  private speakCurrentSegment(): void {
    const synth = getSynth()
    if (!synth || this.status !== 'speaking') return
    const segment = this.segments[this.index]
    if (typeof segment !== 'string') {
      this.finish()
      return
    }
    const Ctor = getUtteranceCtor()
    if (!Ctor) {
      this.finish()
      return
    }

    const utterance = new Ctor(segment)
    const voice = pickVoice(segment, this.readVoices(synth))
    if (voice) utterance.voice = voice
    utterance.rate = this.rate

    // 归属校验：cancel()/变速后旧 utterance 的回调可能迟到，只认当前这一个。
    utterance.onend = () => {
      if (this.utterance !== utterance) return
      this.advance()
    }
    utterance.onerror = () => {
      if (this.utterance !== utterance) return
      this.advance()
    }

    this.utterance = utterance
    try {
      synth.speak(utterance)
    } catch {
      this.advance()
      return
    }
    this.armWatchdog(segment, utterance)
  }

  private armWatchdog(segment: string, utterance: SpeechSynthesisUtterance): void {
    this.clearWatchdog()
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null
      // 该段迟迟没有 onend（部分引擎长段静默中断）⇒ 跳下一段，别把整条卡死。
      if (this.utterance !== utterance) return
      // 必须先 cancel：Web Speech 的 speak() 是排队制，而看门狗触发的前提正是
      // 「这一段既没 onend、又仍是引擎的当前项」——不取消就直接派下一段，新段会
      // 排在它后面永不轮播，余下段全部静默（与 pause/setRate 路径同款写法）。
      this.cancelEngine()
      this.advance()
    }, watchdogMsFor(segment, this.rate))
  }

  private advance(): void {
    this.clearWatchdog()
    this.utterance = null
    this.index += 1
    if (this.index >= this.segments.length) {
      this.finish()
      return
    }
    // 同一条消息的下一段：连续派发即可，无需再等 cancel 间隔。
    this.speakCurrentSegment()
  }

  private finish(): void {
    this.clearTimers()
    this.cancelEngine()
    this.status = 'idle'
    this.currentMessageId = null
    this.segments = []
    this.index = 0
    this.notify()
  }

  private cancelEngine(): void {
    const synth = getSynth()
    // 先摘引用：cancel() 触发的 onend/onerror 会因归属校验不通过而被丢弃。
    this.utterance = null
    try {
      synth?.cancel()
    } catch {
      // 引擎异常不影响状态机自身。
    }
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer !== null) {
      clearTimeout(this.watchdogTimer)
      this.watchdogTimer = null
    }
  }

  private clearTimers(): void {
    this.clearWatchdog()
    if (this.startTimer !== null) {
      clearTimeout(this.startTimer)
      this.startTimer = null
    }
  }

  private notify(): void {
    this.rebuildSnapshot()
    for (const listener of Array.from(this.listeners)) listener(this.snapshot)
  }

  private rebuildSnapshot(): void {
    this.snapshot = {
      status: this.status,
      currentMessageId: this.currentMessageId,
      rate: this.rate,
      canSpeak: this.canSpeak(),
    }
  }
}

/** 模块级单例：全局同一时刻只读一条消息。 */
export const speechService = new SpeechService()

// 模块加载预热一次（浏览器环境才有效；Node/单测环境下为 no-op）。
speechService.warmUp()
