import { describe, expect, it } from 'vitest'

import {
  SPEECH_MAX_SEGMENT_CHARS,
  SPEECH_MAX_TOTAL_CHARS,
  extractSpeakableText,
} from './extractSpeakableText'

const PLACEHOLDER = '（代码块省略）'
const extract = (raw: string) => extractSpeakableText(raw, { codeBlockPlaceholder: PLACEHOLDER })
const joined = (raw: string) => extract(raw).segments.join('')

describe('extractSpeakableText', () => {
  it('把围栏代码块整块替换为占位语（不朗读代码）', () => {
    const raw = ['前面一句。', '```ts', 'const a = 1', 'function f() {}', '```', '后面一句。'].join('\n')
    const { segments } = extract(raw)
    expect(segments).toEqual(['前面一句。', PLACEHOLDER, '后面一句。'])
    expect(joined(raw)).not.toContain('const a = 1')
    expect(joined(raw)).not.toContain('function f')
  })

  it('未闭合的围栏同样整块吞掉（不把代码当散文念）', () => {
    const raw = ['开头。', '```', 'still code here'].join('\n')
    const { segments } = extract(raw)
    expect(segments).toEqual(['开头。', PLACEHOLDER])
  })

  it('行内 code 去反引号留文字', () => {
    expect(joined('执行 `npm run build` 即可。')).toBe('执行 npm run build 即可。')
  })

  it('去标题/列表符/引用符/表格管道', () => {
    const raw = ['## 标题', '- 列表项一', '> 引用句', '| a | b |'].join('\n')
    const text = joined(raw)
    expect(text).not.toContain('#')
    expect(text).not.toContain('- ')
    expect(text).not.toContain('>')
    expect(text).not.toContain('|')
    expect(text).toContain('标题')
    expect(text).toContain('列表项一')
    expect(text).toContain('引用句')
  })

  it('去加粗星号但保留下划线（不破坏 foo_bar 标识符）', () => {
    const text = joined('这是**重点**，变量名 foo_bar 保留。')
    expect(text).toContain('这是重点')
    expect(text).not.toContain('*')
    expect(text).toContain('foo_bar')
  })

  it('链接取文字、图片整条剔除、HTML 标签剥离', () => {
    const raw = '见 [文档](https://example.com/doc) 与 ![截图](/tmp/shot.png)<br>结束。'
    const text = joined(raw)
    expect(text).toContain('文档')
    expect(text).not.toContain('https://example.com')
    expect(text).not.toContain('截图')
    expect(text).not.toContain('shot.png')
    expect(text).not.toContain('<br>')
    expect(text).toContain('结束。')
  })

  it('空串与纯空白 → 无段可读', () => {
    expect(extract('').segments).toEqual([])
    expect(extract('   \n\t ').segments).toEqual([])
    expect(extract('').truncated).toBe(false)
  })

  it('纯图消息 → 无段可读（喇叭不出现）', () => {
    expect(extract('![图](/tmp/a.png)').segments).toEqual([])
  })

  it('按句切段，单段不超过上限', () => {
    const long = '甲'.repeat(SPEECH_MAX_SEGMENT_CHARS * 2 + 30)
    const { segments } = extract(long)
    expect(segments.length).toBeGreaterThan(1)
    for (const segment of segments) {
      expect(segment.length).toBeLessThanOrEqual(SPEECH_MAX_SEGMENT_CHARS)
    }
  })

  it('总长超过上限即截断并置 truncated，保留内容不超过上限', () => {
    const sentence = '这是一句用于测试长度上限的话。'
    const raw = sentence.repeat(Math.ceil(SPEECH_MAX_TOTAL_CHARS / sentence.length) + 20)
    const { segments, truncated } = extract(raw)
    expect(truncated).toBe(true)
    const total = segments.reduce((sum, segment) => sum + segment.length, 0)
    expect(total).toBeLessThanOrEqual(SPEECH_MAX_TOTAL_CHARS)
    expect(segments.length).toBeGreaterThan(0)
  })

  it('未超限时不置 truncated', () => {
    const { truncated } = extract('短消息，一句就够。')
    expect(truncated).toBe(false)
  })
})
