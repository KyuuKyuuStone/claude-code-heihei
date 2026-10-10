/**
 * 朗读（TTS）文案表 —— 独立于五个 locale 主表。
 *
 * 为什么单开一个模块：`i18n/locales/{en,zh,zh-TW,jp,kr}.ts` 已到 2495–2497 行，
 * file-size 门禁（LIMIT=2500，scripts/check-file-size.ts）要求未超标文件不得超限，
 * 且基线表「条目集合只许缩小」——无处安放这十来个新键。故本模块按语言各出一份
 * 显式字典，由 `i18n/index.ts` 合并进对应语言的翻译表（`TranslationKey` 已扩展为
 * 主表键 ∪ 本模块键）。
 *
 * 纪律：per-语言显式字典 + 逐键断言（不写元组解包推导——2026 年曾因拆包错位
 * 导致五语言整体错一环）；五语言键集合必须完全一致，由 speech.test.ts 逐键断言。
 */

export const speechEn = {
  'speech.play': 'Read this message aloud',
  'speech.pause': 'Pause reading',
  'speech.resume': 'Resume reading',
  'speech.settingsTitle': 'Speech',
  'speech.rateLabel': 'Speed',
  'speech.truncated': 'Message is long — only the first part is read',
  'speech.codeBlockPlaceholder': '(code block omitted)',
  'speech.liveStart': 'Reading started',
  'speech.livePaused': 'Paused',
  'speech.liveResumed': 'Reading resumed',
} as const

export const speechZh = {
  'speech.play': '朗读本条消息',
  'speech.pause': '暂停朗读',
  'speech.resume': '继续朗读',
  'speech.settingsTitle': '朗读',
  'speech.rateLabel': '语速',
  'speech.truncated': '内容较长，仅朗读前一部分',
  'speech.codeBlockPlaceholder': '（代码块省略）',
  'speech.liveStart': '开始朗读',
  'speech.livePaused': '已暂停',
  'speech.liveResumed': '已继续朗读',
} as const

export const speechZhTW = {
  'speech.play': '朗讀本條訊息',
  'speech.pause': '暫停朗讀',
  'speech.resume': '繼續朗讀',
  'speech.settingsTitle': '朗讀',
  'speech.rateLabel': '語速',
  'speech.truncated': '內容較長，僅朗讀前一部分',
  'speech.codeBlockPlaceholder': '（程式碼區塊省略）',
  'speech.liveStart': '開始朗讀',
  'speech.livePaused': '已暫停',
  'speech.liveResumed': '已繼續朗讀',
} as const

export const speechJp = {
  'speech.play': 'このメッセージを読み上げる',
  'speech.pause': '読み上げを一時停止',
  'speech.resume': '読み上げを再開',
  'speech.settingsTitle': '読み上げ',
  'speech.rateLabel': '速度',
  'speech.truncated': '内容が長いため、前半のみ読み上げます',
  'speech.codeBlockPlaceholder': '（コードブロックは省略）',
  'speech.liveStart': '読み上げを開始しました',
  'speech.livePaused': '一時停止しました',
  'speech.liveResumed': '読み上げを再開しました',
} as const

export const speechKr = {
  'speech.play': '이 메시지 읽어주기',
  'speech.pause': '읽기 일시중지',
  'speech.resume': '읽기 재개',
  'speech.settingsTitle': '읽어주기',
  'speech.rateLabel': '속도',
  'speech.truncated': '내용이 길어 앞부분만 읽습니다',
  'speech.codeBlockPlaceholder': '(코드 블록 생략)',
  'speech.liveStart': '읽기 시작',
  'speech.livePaused': '일시중지됨',
  'speech.liveResumed': '읽기 재개됨',
} as const

/** 本模块定义的键集合（en 为准；其余语言与此逐键对齐）。 */
export type SpeechKey = keyof typeof speechEn
