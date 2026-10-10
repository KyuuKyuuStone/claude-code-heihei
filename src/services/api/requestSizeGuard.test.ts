/**
 * P-A：发送前字节级预检（`requestSizeGuard.ts`）
 *
 * 用 env 覆盖阈值把「32MB 级」的事情压到 KB 级来测——不需要真造 32MB 载荷，
 * 同时验证了 env 覆盖本身。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  API_REQUEST_MAX_BYTES,
  getApiRequestMaxBytes,
  getApiRequestMediaBytesBudget,
  getApiRequestTriggerBytes,
} from '../../constants/apiLimits.js'
import {
  enforceRequestSizeLimit,
  measureRequestBytes,
  RequestTooLargePreflightError,
} from './requestSizeGuard.js'

const ENV_MAX = 'CC_HEIHEI_API_REQUEST_MAX_BYTES'
const ENV_TRIGGER = 'CC_HEIHEI_API_REQUEST_TRIGGER_BYTES'
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved[ENV_MAX] = process.env[ENV_MAX]
  saved[ENV_TRIGGER] = process.env[ENV_TRIGGER]
})

afterEach(() => {
  for (const key of [ENV_MAX, ENV_TRIGGER]) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]!
  }
})

function imageBlock(dataLen: number) {
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/png',
      data: 'A'.repeat(dataLen),
    },
  }
}

function userWithImage(uuid: string, dataLen: number) {
  return {
    type: 'user',
    uuid,
    message: {
      role: 'user',
      content: [{ type: 'text', text: '看这张图' }, imageBlock(dataLen)],
    },
  }
}

function userWithText(uuid: string, textLen: number) {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content: [{ type: 'text', text: 'x'.repeat(textLen) }] },
  }
}

function makeParams(messages: unknown[]) {
  return { model: 'test-model', max_tokens: 16, messages }
}

describe('阈值常量与 env 覆盖', () => {
  test('默认值：32MB 上限 / 28MB 触发 / 媒体预算取一半', () => {
    delete process.env[ENV_MAX]
    delete process.env[ENV_TRIGGER]
    expect(getApiRequestMaxBytes()).toBe(API_REQUEST_MAX_BYTES)
    expect(getApiRequestMaxBytes()).toBe(32 * 1024 * 1024)
    expect(getApiRequestTriggerBytes()).toBe(28 * 1024 * 1024)
    expect(getApiRequestMediaBytesBudget()).toBe(16 * 1024 * 1024)
  })

  test('env 覆盖上限时，触发阈值与媒体预算按同比例缩放', () => {
    process.env[ENV_MAX] = String(8 * 1024 * 1024)
    delete process.env[ENV_TRIGGER]
    expect(getApiRequestMaxBytes()).toBe(8 * 1024 * 1024)
    expect(getApiRequestTriggerBytes()).toBe(7 * 1024 * 1024) // 8MB × 28/32
    expect(getApiRequestMediaBytesBudget()).toBe(4 * 1024 * 1024) // 8MB ÷ 2
  })

  test('非法 env（0 / 负数 / 非数字）一律回落默认，不静默变成 0（防把总闸关死）', () => {
    for (const bad of ['0', '-1', 'abc', '']) {
      process.env[ENV_MAX] = bad
      expect(getApiRequestMaxBytes()).toBe(API_REQUEST_MAX_BYTES)
    }
  })
})

describe('enforceRequestSizeLimit：降体积 + 阻断', () => {
  test('大图致超限 ⇒ 剥掉媒体、body 降到限内、且**不改入参**（请求期变换）', () => {
    process.env[ENV_MAX] = '100000'
    process.env[ENV_TRIGGER] = '50000'
    const msg = userWithImage('u1', 200_000)
    const params = makeParams([msg])
    const before = measureRequestBytes(params)
    expect(before).toBeGreaterThan(100_000) // 前提：确实超限

    const out = enforceRequestSizeLimit(params)

    // 出了降体积：body 降到限内
    expect(measureRequestBytes(out)).toBeLessThanOrEqual(100_000)
    // 复用了媒体剥离 ⇒ 图片块被 [image] 标记替换（留痕）
    expect(JSON.stringify(out)).not.toContain('"type":"image"')
    expect(JSON.stringify(out)).toContain('[image]')
    // 入参（transcript 侧）原样不动
    expect(JSON.stringify(params)).toContain('"type":"image"')
    expect(params.messages[0]).toBe(msg)
  })

  test('无媒体可剥（纯文本超大）⇒ 抛可定位错误（请求不发）', () => {
    process.env[ENV_MAX] = '2000'
    process.env[ENV_TRIGGER] = '1000'
    const params = makeParams([userWithText('u1', 50_000)])

    let thrown: unknown
    try {
      enforceRequestSizeLimit(params)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(RequestTooLargePreflightError)
    const err = thrown as RequestTooLargePreflightError
    expect(err.measuredBytes).toBeGreaterThan(2000)
    expect(err.limitBytes).toBe(2000)
    expect(err.actions).toEqual([]) // 没有任何可做的降体积动作
  })

  test('低于触发阈值 ⇒ 原样返回同一对象（正常会话零行为变化）', () => {
    process.env[ENV_MAX] = '1000000'
    process.env[ENV_TRIGGER] = '500000'
    const params = makeParams([userWithText('u1', 100)])
    expect(enforceRequestSizeLimit(params)).toBe(params)
  })

  test('触发阈值与上限之间 ⇒ 不降体积、不抛错、原样返回（不误伤）', () => {
    process.env[ENV_MAX] = '100000'
    process.env[ENV_TRIGGER] = '1000'
    const params = makeParams([userWithText('u1', 5_000)])
    const bytes = measureRequestBytes(params)
    expect(bytes).toBeGreaterThan(1000)
    expect(bytes).toBeLessThanOrEqual(100_000)
    const out = enforceRequestSizeLimit(params)
    expect(out).toBe(params)
  })

  test('多条大图时按体积由大到小剥（最省动作达标）', () => {
    process.env[ENV_MAX] = '120000'
    process.env[ENV_TRIGGER] = '60000'
    const small = userWithImage('small', 5_000)
    const huge = userWithImage('huge', 200_000)
    const out = enforceRequestSizeLimit(makeParams([small, huge]))

    expect(measureRequestBytes(out)).toBeLessThanOrEqual(120_000)
    // 先剥的是那条巨大的：小的那条（5KB）应当留下
    const kept = JSON.stringify(out)
    expect(kept).toContain('"type":"image"') // small 仍在
    expect(kept).toContain('[image]') // huge 被剥
  })
})
