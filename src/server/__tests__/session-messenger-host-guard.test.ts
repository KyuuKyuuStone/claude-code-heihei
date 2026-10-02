import { afterEach, describe, expect, mock, test } from 'bun:test'
import { setDeliverOverrideForTests, sessionMessenger } from '../services/sessionMessenger.js'

// v1.7.2 P0-a（裁决二十③）：投递入口的 serverHost fail-fast。
//
// 背景：`127.0.0.1:0` 这类假地址曾被 supervisorProtocolNotice 使用；deliver 对未运行
// 会话会 startSession(..., buildSdkUrl(host)) —— 端口 0 的 SDK URL 让 CLI 永远连不上，
// 产生**静默僵尸会话**（CLI 活着、零日志、消息滞留 pendingOutbound、HTTP 仍 201）。
// 这里断言：坏地址在入口即被拒（显形为错误），且**不产生任何副作用**。

afterEach(() => {
  setDeliverOverrideForTests(null)
  mock.restore()
})

describe('SessionMessenger.deliver 的 serverHost 守卫', () => {
  test('判据2：port=0 一律拒绝并抛 badRequest', async () => {
    await expect(
      sessionMessenger.deliver('any-session', '内容', '127.0.0.1:0'),
    ).rejects.toThrow(/Invalid serverHost/)
  })

  test('判据2（变体）：缺端口 / 非数字端口 / 越界端口 同样拒绝', async () => {
    for (const bad of ['127.0.0.1', 'localhost', '127.0.0.1:abc', '127.0.0.1:65536', '']) {
      await expect(
        sessionMessenger.deliver('any-session', '内容', bad),
      ).rejects.toThrow(/Invalid serverHost/)
    }
  })

  test('合法 host:port 通过守卫（继续走后续校验，而不是被 host 守卫拦下）', async () => {
    // 用一个不存在的 targetSessionId：应当因「会话找不到」而失败，
    // 而不是因 serverHost 无效 —— 以此证明合法 host 未被误伤。
    const err = await sessionMessenger
      .deliver('00000000-0000-4000-8000-000000000000', '内容', '127.0.0.1:53100')
      .then(() => null)
      .catch((e: Error) => e)
    expect(err).not.toBeNull()
    expect(String(err!.message)).not.toContain('Invalid serverHost')
  })
})
