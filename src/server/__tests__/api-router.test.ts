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

// v1.4.0 阶段1-A ②：身份探活——本机存在对任意路径回 200+空 body 的冒充服务
// （华硕 ArmourySocketServer），探活方需要一击区分「连上的是不是本服务」。
describe('GET /api/whoami identity probe', () => {
  test('returns app/version/pid/startedAt', async () => {
    const res = await handleApiRequest(
      new Request('http://localhost/api/whoami'),
      new URL('http://localhost/api/whoami'),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as {
      app?: string
      version?: string
      pid?: number
      startedAt?: string
    }
    expect(body.app).toBe('cc-heihei')
    expect(typeof body.version).toBe('string')
    expect(body.version!.length).toBeGreaterThan(0)
    expect(body.pid).toBe(process.pid)
    expect(Number.isNaN(Date.parse(body.startedAt ?? ''))).toBe(false)
  })

  test('only responds to GET (other methods fall through)', async () => {
    const res = await handleApiRequest(
      new Request('http://localhost/api/whoami', { method: 'POST' }),
      new URL('http://localhost/api/whoami'),
    )
    // router 对未知资源返回 404（不会把 whoami 结果泄漏给 POST）
    expect(res.status).toBe(404)
  })

  test('is listed in the /api catalog', async () => {
    const res = await handleApiRequest(
      new Request('http://localhost/api'),
      new URL('http://localhost/api'),
    )
    const body = (await res.json()) as { endpoints?: Array<{ path?: string }> }
    expect(body.endpoints!.some((e) => e.path === '/api/whoami')).toBe(true)
  })

  // v1.6.0 CLI 契约 §五：能力探测。客户端靠 capabilities 区分新旧服务端，
  // 不必再对每个接口试探。
  test('declares capabilities so CLI tools can probe new vs old servers', async () => {
    const res = await handleApiRequest(
      new Request('http://localhost/api/whoami'),
      new URL('http://localhost/api/whoami'),
    )
    const body = (await res.json()) as { capabilities?: unknown }
    expect(Array.isArray(body.capabilities)).toBe(true)
    const caps = body.capabilities as string[]
    expect(caps).toContain('collab-tasks')
    expect(caps).toContain('report-caller-check')
    expect(caps).toContain('mailbox-report')
    // 名字只增不改/不删
    expect(new Set(caps).size).toBe(caps.length)
  })

  // 旧服务端没有 capabilities，客户端退化为探测某个协作接口是否 404。
  // 这里锁死那个可识别信号仍成立：未知资源必须 404 且文案含 "Unknown API resource"。
  test('keeps the fallback probe signal: unknown API resources answer 404 with a recognizable message', async () => {
    const res = await handleApiRequest(
      new Request('http://localhost/api/definitely-not-a-real-resource'),
      new URL('http://localhost/api/definitely-not-a-real-resource'),
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(JSON.stringify(body)).toContain('Unknown API resource')
  })
})

