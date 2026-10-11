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
 *   · 试听：`preview(text, voiceURI)` 与消息朗读共用单例（天然停旧读新）；消息在播时
 *     先 pause（记住段索引）、试听完 resume，试听期间快照 previewing=true。
 *
 * 依赖纪律：本模块属 lib 层，不 import components/ 与 stores/（语速由调用方经
 * setRate / play 传入；已选音色 voiceURI 经 setVoiceURI 注入，初值直接读本模块的
 * localStorage 键）。
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
  /** 正在试听音色（设置页试听键据此置灰防重复点击）。 */
  previewing: boolean
  /**
   * 正在试听的 voiceURI（null = 未试听）。快照里带 URI 才能让**对应那一行**显示停止态；
   * 只给 previewing 布尔值的话，多行试听键无法判断谁在响。
   */
  previewVoiceURI: string | null
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

// 音色策略（书写系统识别 / 择优打分 / 持久化 / 名称清洗）全在 speechVoice.ts：
// 本模块只管引擎与队列，策略保持纯函数可单测。storedURI 由调用方经 setVoiceURI 注入
// （lib 层不 import stores 的纪律不破）。detectSpeechScript 从旧位置迁出，此处**原样
// 再导出**，既有 import 点不受影响。
import { readStoredSpeechVoiceURI, resolveVoice } from './speechVoice'

export { detectSpeechScript, type SpeechScript } from './speechVoice'

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
  /** 已选音色 voiceURI（'' = 自动择优）；初值读 localStorage，调用方经 setVoiceURI 同步。 */
  private voiceURI: string = readStoredSpeechVoiceURI()
  private previewing = false
  private previewVoiceURI: string | null = null
  /** 试听打断的消息朗读：试听完要 resume 回 'speaking'；null = 试听前不是 speaking。 */
  private previewResumeStatus: 'speaking' | null = null
  private previewUtterance: SpeechSynthesisUtterance | null = null
  private previewTimer: ReturnType<typeof setTimeout> | null = null
  private snapshot: SpeechSnapshot = {
    status: 'idle',
    currentMessageId: null,
    rate: SPEECH_RATE_DEFAULT,
    canSpeak: false,
    previewing: false,
    previewVoiceURI: null,
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

  getVoiceURI = (): string => this.voiceURI

  /** 注入已选音色（空串 = 自动择优）。由调用方（settingsStore / 设置页）在变更时同步。 */
  setVoiceURI(voiceURI: string): void {
    this.voiceURI = voiceURI ?? ''
  }

  play(messageId: string, segments: string[], rate?: number): void {
    if (segments.length === 0) return
    if (!this.canSpeak()) return
    this.endPreview(false, false)
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

  /**
   * 试听音色（设置页用；不进分段队列、不占 currentMessageId）。
   *
   * 互斥：消息在播 ⇒ 先 pause（记住段索引）→ 试听完 resume 续播原消息；空闲 ⇒ 直接读。
   * 已在试听 ⇒ **直接拒绝**（试听键的重复点击在 UI 侧是「停止」，这里只防重入）。
   */
  preview(text: string, voiceURI: string): void {
    const body = text.trim()
    if (!body) return
    if (!this.canSpeak()) return
    if (this.previewing) return
    if (!getSynth() || !getUtteranceCtor()) return

    const wasSpeaking = this.status === 'speaking'
    if (wasSpeaking) this.pause()
    this.previewResumeStatus = wasSpeaking ? 'speaking' : null
    this.previewing = true
    this.previewVoiceURI = voiceURI || null
    this.notify()

    // 与消息朗读同规矩：cancel()（pause 里刚做过）之后必须隔 CANCEL_RESTART_DELAY_MS
    // 再派发，否则 Windows/Chromium 会吞掉试听句的首字。
    this.clearTimers()
    this.startTimer = setTimeout(() => {
      this.startTimer = null
      this.startPreviewUtterance(body, voiceURI)
    }, CANCEL_RESTART_DELAY_MS)
  }

  /** 手动停止试听（试听键的「停止」态）。 */
  stopPreview(): void {

    if (!this.previewing) return
    this.endPreview(true, true)
  }

  isPreviewing = (): boolean => this.previewing

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
    // 试听同样属于本单例的音频占用：切会话要一并停掉，否则 previewing 会永远为真。
    this.endPreview(false, true)
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

  /** 真正派发试听句（延迟窗口结束、且仍处于试听态时才走到这里）。 */
  private startPreviewUtterance(body: string, voiceURI: string): void {
    if (!this.previewing) return
    const synth = getSynth()
    const Ctor = getUtteranceCtor()
    if (!synth || !Ctor) {
      this.endPreview(true, false)
      return
    }
    const utterance = new Ctor(body)
    // 只认传入的 voiceURI：'' = 自动择优。若回落到 this.voiceURI，设置页的「自动」
    // 项会试听到已选音色，与该项语义正好相反。
    const voice = resolveVoice(body, this.readVoices(synth), voiceURI)
    if (voice) utterance.voice = voice
    utterance.rate = this.rate
    utterance.onend = () => {
      if (this.previewUtterance !== utterance) return
      this.endPreview(true, false)
    }
    utterance.onerror = () => {
      if (this.previewUtterance !== utterance) return
      this.endPreview(true, false)
    }
    this.previewUtterance = utterance
    // 试听句很短：挂个看门狗兜住「静默中断不发 onend」的引擎，免得 previewing 永远为真。
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null
      if (this.previewUtterance !== utterance) return
      this.endPreview(true, false)
    }, watchdogMsFor(body, this.rate))
    try {
      synth.speak(utterance)
    } catch {
      this.endPreview(true, false)
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
    const voice = resolveVoice(segment, this.readVoices(synth), this.voiceURI)
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

  private clearPreviewTimer(): void {
    if (this.previewTimer !== null) {
      clearTimeout(this.previewTimer)
      this.previewTimer = null
    }
  }

  /**
   * 收束试听：清标志并（可选）取消引擎里在响的试听句。
   *
   * @param resumeMessage 试听前消息在播 ⇒ 结束后 resume 续播原消息。
   * @param cancel 手动停止/被打断时取消引擎（自然结束的 onend 不必再 cancel）。
   */
  private endPreview(resumeMessage: boolean, cancel: boolean): void {
    // 待派发的试听句计时器与看门狗一起清；消息侧的计时器此刻本就没有在跑（已 pause）。
    this.clearTimers()
    this.clearPreviewTimer()
    const wasPreviewing = this.previewing
    this.previewUtterance = null
    this.previewing = false
    this.previewVoiceURI = null
    const shouldResume = resumeMessage && this.previewResumeStatus === 'speaking'
    this.previewResumeStatus = null
    if (cancel) this.cancelEngine()
    if (wasPreviewing) this.notify()
    if (shouldResume) this.resume()
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
      previewing: this.previewing,
      previewVoiceURI: this.previewVoiceURI,
    }
  }
}

/** 模块级单例：全局同一时刻只读一条消息。 */
export const speechService = new SpeechService()

// 模块加载预热一次（浏览器环境才有效；Node/单测环境下为 no-op）。
speechService.warmUp()
