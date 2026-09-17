import { describe, expect, test } from 'bun:test'
import { handleApiRequest } from '../router.js'

/**
 * GET /api 端点名录：带斜杠与不带斜杠都必须返回 JSON。
 * 实测回归（2026-09-16）：/api（无斜杠）曾落 SPA fallback 返回 HTML——
 * 根因是 server/index.ts 外层分流只认 /api/ 前缀，router.ts:39 的
 * `path === '/api'` 分支不可达；外层已修，这里锁死 router 层两路行为。
 */
describe('GET /api catalog (with and without trailing slash)', () => {
  test('GET /api returns the endpoint catalog JSON', async () => {
    const res = await handleApiRequest(
      new Request('http://localhost/api'),
      new URL('http://localhost/api'),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { endpoints?: unknown[] }
    expect(Array.isArray(body.endpoints)).toBe(true)
    expect(body.endpoints!.length).toBeGreaterThan(0)
  })

  test('GET /api/ returns the endpoint catalog JSON', async () => {
    const res = await handleApiRequest(
      new Request('http://localhost/api/'),
      new URL('http://localhost/api/'),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { endpoints?: unknown[] }
    expect(Array.isArray(body.endpoints)).toBe(true)
  })
})
