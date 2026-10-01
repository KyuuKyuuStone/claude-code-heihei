/**
 * 附件落盘子系统（v1.7 结构拆分第①批 · 纯移动）。
 *
 * 原来住在 conversationService.ts 的 ConversationService 类里（2521-2755），
 * 本批逐字搬到这里。这些方法彼此自洽——只用参数、模块级 import 和同批搬来的
 * 兄弟函数，**不碰任何实例状态**（this.sessions / this.providerService 之类），
 * 所以能作为独立函数存在。原文件保留同名类字段指向这里（见那里的委托段），
 * 因此 `this.buildUserContent(...)` 这类调用点**一行没改**。
 *
 * 唯一的机械变换：方法体内的 `this.foo(...)` → `foo(...)`（同模块直调），
 * 共 16 处，全部是同一个模式。
 */

import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { logError } from '../../../utils/log.js'
import {
  createImageMetadataText,
  maybeResizeAndDownsampleImageBuffer,
} from '../../../utils/imageResizer.js'

type AttachmentRef = {
  type: 'file' | 'image'
  name?: string
  path?: string
  data?: string
  mimeType?: string
  isDirectory?: boolean
}

type UserContentBlock = Record<string, unknown>

type MaterializedAttachments = {
  pathPrefix: string
  imageBlocks: UserContentBlock[]
  imageMetadataTexts: string[]
}

export type { AttachmentRef, UserContentBlock, MaterializedAttachments }

export async function buildUserContent(
  content: string,
  sessionId: string,
  attachments?: AttachmentRef[],
): Promise<UserContentBlock[]> {
  const materialized = await materializeAttachments(sessionId, attachments)
  const trimmed = content.trim()
  const text = materialized.pathPrefix
    ? `${materialized.pathPrefix}${trimmed || 'Please analyze the attached files.'}`.trim()
    : trimmed

  const blocks: UserContentBlock[] = text
    ? [{ type: 'text', text }]
    : materialized.imageBlocks.length > 0
      ? [{ type: 'text', text: 'Please analyze the attached image.' }]
      : []

  blocks.push(...materialized.imageBlocks)
  for (const metadataText of materialized.imageMetadataTexts) {
    blocks.push({ type: 'text', text: metadataText })
  }

  return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }]
}

export async function materializeAttachments(
  sessionId: string,
  attachments?: AttachmentRef[],
): Promise<MaterializedAttachments> {
  const empty = (): MaterializedAttachments => ({
    pathPrefix: '',
    imageBlocks: [],
    imageMetadataTexts: [],
  })

  if (!attachments || attachments.length === 0) {
    return empty()
  }

  const uploadDir = path.join(
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    'uploads',
    sessionId,
  )

  const savedPaths: string[] = []
  const imageBlocks: UserContentBlock[] = []
  const imageMetadataTexts: string[] = []
  for (const attachment of attachments) {
    if (shouldInlineImageAttachment(attachment)) {
      const image = await materializeImageAttachment(attachment, uploadDir)
      if (image) {
        imageBlocks.push(image.block)
        if (image.metadataText) imageMetadataTexts.push(image.metadataText)
        continue
      }
    }

    if (attachment.path) {
      savedPaths.push(attachment.path)
      continue
    }

    if (!attachment.data) continue

    const parsed = parseAttachmentData(attachment.data)
    if (!parsed) continue

    const ext = getAttachmentExtension({
      ...attachment,
      mimeType: attachment.mimeType ?? parsed.mimeType,
    })
    const fileName = sanitizeAttachmentName(attachment.name, attachment.type, ext)
    const outPath = await writeUploadAttachment(uploadDir, fileName, parsed.payload)
    savedPaths.push(outPath)
  }

  return {
    pathPrefix: savedPaths.length > 0
      ? savedPaths.map((filePath) => `@"${filePath}"`).join(' ') + ' '
      : '',
    imageBlocks,
    imageMetadataTexts,
  }
}

export function parseAttachmentData(data: string): { payload: Buffer; mimeType?: string } | null {
  const match = data.match(/^data:([^;,]+)?;base64,(.*)$/)
  const encoded = match ? match[2] : data

  try {
    return {
      payload: Buffer.from(encoded ?? '', 'base64'),
      mimeType: match?.[1],
    }
  } catch {
    return null
  }
}

export async function materializeImageAttachment(
  attachment: AttachmentRef,
  uploadDir: string,
): Promise<{ block: UserContentBlock; metadataText?: string } | null> {
  const source = readImageAttachmentPayload(attachment)
  if (!source) {
    return null
  }

  try {
    const resized = await maybeResizeAndDownsampleImageBuffer(
      source.payload,
      source.payload.length,
      source.ext,
    )
    const normalizedExt = normalizeImageExtension(resized.mediaType)
    const storedName = replaceFileExtension(
      sanitizeAttachmentName(attachment.name, attachment.type, normalizedExt),
      normalizedExt,
    )
    const sourcePath = source.sourcePath ?? (await writeUploadAttachment(
      uploadDir,
      storedName,
      resized.buffer,
    ))
    const metadataText = resized.dimensions
      ? createImageMetadataText(resized.dimensions, sourcePath)
      : sourcePath
        ? `[Image source: ${sourcePath}]`
        : undefined

    return {
      block: {
        type: 'image',
        source: {
          type: 'base64',
          media_type: `image/${normalizedExt}`,
          data: resized.buffer.toString('base64'),
        },
      },
      metadataText: metadataText ?? undefined,
    }
  } catch (error) {
    logError(error)
    console.warn(
      `[ConversationService] Failed to inline image attachment ${attachment.name ?? '<unnamed>'}; falling back to file path`,
    )
    return null
  }
}

export function readImageAttachmentPayload(
  attachment: AttachmentRef,
): { payload: Buffer; ext: string; sourcePath?: string } | null {
  if (attachment.data) {
    const parsed = parseAttachmentData(attachment.data)
    if (!parsed) return null
    return {
      payload: parsed.payload,
      ext: getAttachmentExtension({
        ...attachment,
        mimeType: attachment.mimeType ?? parsed.mimeType,
      }),
    }
  }

  if (!attachment.path || attachment.isDirectory) {
    return null
  }

  try {
    return {
      payload: fs.readFileSync(attachment.path),
      ext: getAttachmentExtension(attachment),
      sourcePath: attachment.path,
    }
  } catch (error) {
    logError(error)
    return null
  }
}

export function shouldInlineImageAttachment(attachment: AttachmentRef): boolean {
  if (attachment.isDirectory) return false
  if (attachment.type === 'image') return true
  if (attachment.mimeType?.startsWith('image/')) return true
  const candidate = attachment.path ?? attachment.name ?? ''
  return /\.(png|jpe?g|gif|webp)$/i.test(candidate)
}

/**
 * C6（v1.5.0）：改异步写——附件可达数 MB，同步 writeFileSync 阻塞事件循环，
 * 表现为「发带图消息时整个服务端卡一下」（多人协作时放大）。
 */
export async function writeUploadAttachment(uploadDir: string, fileName: string, payload: Buffer): Promise<string> {
  // 注意用 fs/promises：本模块顶部的 `fs` 是 node:fs（回调 API）
  await fsp.mkdir(uploadDir, { recursive: true })
  const outPath = path.join(uploadDir, `${crypto.randomUUID()}-${fileName}`)
  await fsp.writeFile(outPath, payload)
  return outPath
}

export function normalizeImageExtension(ext: string): string {
  const clean = ext.split('/').pop()?.split('+')[0]?.toLowerCase() || 'png'
  return clean === 'jpg' ? 'jpeg' : clean
}

export function replaceFileExtension(fileName: string, ext: string): string {
  const cleanExt = normalizeImageExtension(ext)
  const base = fileName.replace(/\.[a-z0-9]+$/i, '')
  return `${base}.${cleanExt}`
}

export function getAttachmentExtension(attachment: AttachmentRef): string {
  const byName = attachment.name?.match(/\.([a-z0-9]+)$/i)?.[1]
  if (byName) return byName

  const byPath = attachment.path?.match(/\.([a-z0-9]+)$/i)?.[1]
  if (byPath) return byPath

  const byMime = attachment.mimeType?.split('/')[1]?.split('+')[0]
  if (byMime) return byMime

  return attachment.type === 'image' ? 'png' : 'bin'
}

export function sanitizeAttachmentName(
  name: string | undefined,
  type: AttachmentRef['type'],
  ext: string,
): string {
  const fallback = `${type}-attachment.${ext}`
  const normalized = (name || fallback).replace(/[^a-zA-Z0-9._-]/g, '_')
  return normalized || fallback
}
