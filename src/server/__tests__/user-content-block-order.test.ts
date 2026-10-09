/**
 * v1.7.4 修缺陷 · 不变量：**用户正文块永远是最后一个 text 块**
 *
 * 依据：CLI 取最后一个 text 块当命令串（`src/utils/processUserInput/processUserInput.ts:338-341`），
 * 斜杠门只看它的行首（同文件 :533-535）。任何给模型看的附加物（花名册系统段、附件路径引用、
 * 图片块、图片元数据）排到正文之后 ⇒ 主管会话里所有走服务端→CLI 的斜杠命令被当普通文本送模型。
 *
 * 本文件把这条不变量落成**可测断言**（改坏必红）。
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildUserContent } from '../services/conversation/attachments.js'

const PNG_1x1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-blockorder-'))
  process.env.CLAUDE_CONFIG_DIR = tmpDir
})
afterEach(async () => {
  delete process.env.CLAUDE_CONFIG_DIR
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

type Block = { type?: string; text?: string }

/** 不变量断言：**末块**是 text 且内容等于用户正文；正文**独占**该块（未被复制/粘连）。 */
function expectBodyLast(blocks: Block[], expectedBody: string): void {
  const last = blocks[blocks.length - 1]
  expect(last?.type).toBe('text')
  expect(last?.text).toBe(expectedBody)
  expect(blocks.filter((block) => block.text === expectedBody)).toHaveLength(1)
  expect(blocks.slice(0, -1).every((block) => block.text !== expectedBody)).toBe(true)
}

/** 忠实复现 CLI 取串规则 + 斜杠门（processUserInput.ts:338-341 / :533-535）。 */
function cliSlashGate(blocks: Block[]): string | null {
  const lastBlock = blocks[blocks.length - 1]
  const inputString = lastBlock?.type === 'text' ? (lastBlock.text ?? null) : null
  return inputString !== null && inputString.startsWith('/') ? inputString : null
}

describe('buildUserContent 不变量：用户正文块永远是最后一个 text 块', () => {
  test('① 纯正文', async () => {
    const blocks = await buildUserContent('帮我看看进度', 's1')
    expectBodyLast(blocks, '帮我看看进度')
  })

  test('② 系统段（花名册摘要）在前，正文仍在最后', async () => {
    const blocks = await buildUserContent('帮我看看进度', 's1', undefined, '<system-reminder>【在册】…</system-reminder>')
    expect(blocks.length).toBe(2)
    expect(blocks[0]?.text).toContain('【在册】')
    expectBodyLast(blocks, '帮我看看进度')
  })

  test('③ 附件路径引用**独立成块**且在正文之前（同源问题①）', async () => {
    const blocks = await buildUserContent('帮我看看这份日志', 's1', [
      { type: 'file', path: '/tmp/a.log', name: 'a.log' },
    ])
    expect(blocks.length).toBe(2)
    // 引用自成一块，且是 `@"path"` 形态（桌面端 extractLeadingFileReferences 仍认行首）
    expect(blocks[0]?.type).toBe('text')
    expect(blocks[0]?.text).toBe('@"/tmp/a.log"')
    // 正文块**不含**引用（一字不动）
    expectBodyLast(blocks, '帮我看看这份日志')
  })

  test('④ 带附件的斜杠命令仍能过 CLI 门（同源问题①的判红点）', async () => {
    const blocks = await buildUserContent('/compact', 's1', [
      { type: 'file', path: '/tmp/a.log', name: 'a.log' },
    ])
    expect(cliSlashGate(blocks)).toBe('/compact')
    expect(blocks[blocks.length - 1]?.text).not.toContain('@"')
  })

  test('⑤ 图片块排在正文之前（同源问题②：不得 push 在最后）', async () => {
    const blocks = await buildUserContent('看看这张图', 's1', [
      { type: 'image', name: 'p.png', mimeType: 'image/png', data: PNG_1x1 },
    ])
    // 图片块（非 text）必须出现在正文块之前
    const bodyIndex = blocks.length - 1
    const imageIndexes = blocks
      .map((block, i) => ({ block, i }))
      .filter(({ block }) => block.type !== 'text')
      .map(({ i }) => i)
    expect(imageIndexes.length).toBeGreaterThan(0)
    for (const i of imageIndexes) expect(i).toBeLessThan(bodyIndex)
    expectBodyLast(blocks, '看看这张图')
    // 图片元数据（若有）也在正文之前 ⇒ 门依旧可用
    expect(cliSlashGate(await buildUserContent('/compact', 's1', [
      { type: 'image', name: 'p.png', mimeType: 'image/png', data: PNG_1x1 },
    ]))).toBe('/compact')
  })

  test('⑥ 空正文 + 附件：占位说明仍是最后一个 text 块', async () => {
    const files = await buildUserContent('', 's1', [{ type: 'file', path: '/tmp/a.log', name: 'a.log' }])
    expectBodyLast(files, 'Please analyze the attached files.')
    const images = await buildUserContent('', 's1', [
      { type: 'image', name: 'p.png', mimeType: 'image/png', data: PNG_1x1 },
    ])
    expectBodyLast(images, 'Please analyze the attached image.')
  })

  test('⑦ 全组合扫一遍：任何形态下末块都是 text 且等于用户正文', async () => {
    const cases: Array<{ name: string; body: string; attachments?: Parameters<typeof buildUserContent>[2]; system?: string }> = [
      { name: '纯正文', body: '正文' },
      { name: '系统段', body: '正文', system: '<system-reminder>【在册】</system-reminder>' },
      { name: '文件', body: '正文', attachments: [{ type: 'file', path: '/tmp/a.log', name: 'a.log' }] },
      { name: '文件+系统段', body: '/goal', attachments: [{ type: 'file', path: '/tmp/a.log', name: 'a.log' }], system: '<system-reminder>【在册】</system-reminder>' },
      { name: '图片', body: '正文', attachments: [{ type: 'image', name: 'p.png', mimeType: 'image/png', data: PNG_1x1 }] },
      { name: '文件+图片', body: '/compact', attachments: [{ type: 'file', path: '/tmp/a.log', name: 'a.log' }, { type: 'image', name: 'p.png', mimeType: 'image/png', data: PNG_1x1 }] },
    ]
    for (const c of cases) {
      const blocks = await buildUserContent(c.body, 's1', c.attachments, c.system)
      expectBodyLast(blocks, c.body)
    }
  })
})
