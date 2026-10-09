import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

let imageProcessorShouldThrow = false

const getImageProcessorMock = mock(async () => {
  if (imageProcessorShouldThrow) {
    throw new Error('image processor unavailable')
  }
  return (input: Buffer) => {
    let output = input
    const instance = {
      metadata: async () => ({ width: 3000, height: 4000, format: 'png' }),
      resize: () => {
        output = Buffer.from('resized-image')
        return instance
      },
      jpeg: () => {
        output = Buffer.from('jpeg-image')
        return instance
      },
      png: () => {
        output = Buffer.from('png-image')
        return instance
      },
      webp: () => {
        output = Buffer.from('webp-image')
        return instance
      },
      toBuffer: async () => output,
    }
    return instance
  }
})

// 原为顶层 mock.module(...)：进程级替换，跨文件可见。改为 beforeEach 里 spyOnInstall、
// afterEach 统一 mock.restore()，作用域限本文件用例。
import * as imageProcessorModule from '../../tools/FileReadTool/imageProcessor.js'

const { ConversationService } = await import('../services/conversationService.js')

let tmpDir: string
let originalConfigDir: string | undefined

beforeEach(async () => {
  spyOn(imageProcessorModule, 'getImageProcessor').mockImplementation(
    getImageProcessorMock as typeof imageProcessorModule.getImageProcessor,
  )
  getImageProcessorMock.mockClear()
  imageProcessorShouldThrow = false
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-attachments-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
})

afterEach(async () => {
  mock.restore()
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('ConversationService attachment materialization', () => {
  test('inlines image data attachments without resizing when already within API limits', async () => {
    const svc = new ConversationService()
    const sent: unknown[] = []
    const sessionId = 'session-image-normalize'
    const original = Buffer.from('original-image')

    ;(svc as any).sessions.set(sessionId, {
      sdkSocket: {
        send(data: string) {
          sent.push(JSON.parse(data))
        },
      },
      pendingOutbound: [],
    })

    const ok = await svc.sendMessage(sessionId, '这张图说了什么？', [
      {
        type: 'image',
        name: 'pasted-image.png',
        mimeType: 'image/png',
        data: `data:image/png;base64,${original.toString('base64')}`,
      },
    ])

    expect(ok).toBe(true)
    expect(getImageProcessorMock).toHaveBeenCalled()
    expect(sent).toHaveLength(1)

    const payload = sent[0] as {
      message: { content: Array<{ type: string; text?: string; source?: { media_type?: string; data?: string } }> }
    }
    const textBlocks = payload.message.content.filter((block) => block.type === 'text')
    const imageBlocks = payload.message.content.filter((block) => block.type === 'image')
    // v1.7.4 不变量：正文是**最后一个** text 块（元数据等排在它之前，见 attachments.ts 注释）
    expect(textBlocks[textBlocks.length - 1]?.text).toBe('这张图说了什么？')
    expect(textBlocks.some((block) => block.text?.includes('@"'))).toBe(false)
    expect(imageBlocks).toHaveLength(1)
    expect(imageBlocks[0]?.source?.media_type).toBe('image/png')
    expect(imageBlocks[0]?.source?.data).toBe(original.toString('base64'))

    const metadataText = textBlocks.find((block) => block.text?.startsWith('[Image:'))?.text
    const uploadPath = metadataText?.match(/source: ([^,\]]+)/)?.[1]
    expect(uploadPath).toBeTruthy()
    expect(uploadPath?.endsWith('.png')).toBe(true)
    expect(await fs.readFile(uploadPath!)).toEqual(original)
  })

  test('falls back to an upload path when image normalization cannot produce a block', async () => {
    const svc = new ConversationService()
    const sent: unknown[] = []
    const sessionId = 'session-image-fallback'
    const original = createOversizedPngHeader()
    imageProcessorShouldThrow = true

    ;(svc as any).sessions.set(sessionId, {
      sdkSocket: {
        send(data: string) {
          sent.push(JSON.parse(data))
        },
      },
      pendingOutbound: [],
    })

    const ok = await svc.sendMessage(sessionId, '', [
      {
        type: 'image',
        name: 'pasted-image.png',
        mimeType: 'image/png',
        data: `data:image/png;base64,${original.toString('base64')}`,
      },
    ])

    expect(ok).toBe(true)

    const payload = sent[0] as { message: { content: Array<{ text: string }> } }
    const text = payload.message.content[0]?.text ?? ''
    const uploadPath = text.match(/@"([^"]+)"/)?.[1]
    expect(uploadPath).toBeTruthy()
    expect(uploadPath?.endsWith('.png')).toBe(true)
    expect(await fs.readFile(uploadPath!)).toEqual(original)
  })

  test('inlines image file paths instead of asking the model to Read them first', async () => {
    const svc = new ConversationService()
    const sent: unknown[] = []
    const sessionId = 'session-image-path'
    const original = Buffer.from('path-image')
    const imagePath = path.join(tmpDir, 'screen.png')
    await fs.writeFile(imagePath, original)

    ;(svc as any).sessions.set(sessionId, {
      sdkSocket: {
        send(data: string) {
          sent.push(JSON.parse(data))
        },
      },
      pendingOutbound: [],
    })

    const ok = await svc.sendMessage(sessionId, '看这个截图', [
      {
        type: 'file',
        path: imagePath,
      },
    ])

    expect(ok).toBe(true)

    const payload = sent[0] as {
      message: { content: Array<{ type: string; text?: string; source?: { media_type?: string; data?: string } }> }
    }
    const textBlocks = payload.message.content.filter((block) => block.type === 'text')
    const imageBlocks = payload.message.content.filter((block) => block.type === 'image')
    // v1.7.4 不变量：正文是**最后一个** text 块（元数据等排在它之前）
    expect(textBlocks[textBlocks.length - 1]?.text).toBe('看这个截图')
    expect(textBlocks.some((block) => block.text?.includes('@"'))).toBe(false)
    expect(textBlocks.some((block) => block.text?.includes(`source: ${imagePath}`))).toBe(true)
    expect(imageBlocks).toHaveLength(1)
    expect(imageBlocks[0]?.source?.media_type).toBe('image/png')
    expect(imageBlocks[0]?.source?.data).toBe(original.toString('base64'))
  })
})

function createOversizedPngHeader(): Buffer {
  const buffer = Buffer.alloc(24)
  buffer[0] = 0x89
  buffer[1] = 0x50
  buffer[2] = 0x4e
  buffer[3] = 0x47
  buffer.writeUInt32BE(9000, 16)
  buffer.writeUInt32BE(9000, 20)
  return buffer
}
