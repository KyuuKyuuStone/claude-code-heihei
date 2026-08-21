import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { handleHeiheiGrokOAuthApi } from '../api/heihei-grok-oauth.js'
import { heiheiGrokOAuthService } from '../services/heiheiGrokOAuthService.js'

let tempDir: string
let previousConfigDir: string | undefined

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'heihei-grok-oauth-api-'))
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tempDir
})

afterEach(async () => {
  heiheiGrokOAuthService.dispose()
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe('Heihei Grok OAuth API', () => {
  test('serves a clear local success page after browser authorization', async () => {
    const response = await handleHeiheiGrokOAuthApi(
      new Request('http://localhost/api/heihei-grok-oauth/success'),
      new URL('http://localhost/api/heihei-grok-oauth/success'),
      ['api', 'heihei-grok-oauth', 'success'],
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('text/html')
    expect(await response.text()).toContain('Grok Login Successful')
  })

  test('returns status without exposing token material and logs out', async () => {
    await heiheiGrokOAuthService.saveTokens({
      accessToken: 'secret-access',
      refreshToken: 'secret-refresh',
      expiresAt: Date.now() + 3600_000,
      email: 'user@example.com',
    })
    const statusResponse = await handleHeiheiGrokOAuthApi(
      new Request('http://localhost/api/heihei-grok-oauth'),
      new URL('http://localhost/api/heihei-grok-oauth'),
      ['api', 'heihei-grok-oauth'],
    )
    const statusText = await statusResponse.text()
    expect(statusText).toContain('user@example.com')
    expect(statusText).not.toContain('secret-access')
    expect(statusText).not.toContain('secret-refresh')

    const logoutResponse = await handleHeiheiGrokOAuthApi(
      new Request('http://localhost/api/heihei-grok-oauth', { method: 'DELETE' }),
      new URL('http://localhost/api/heihei-grok-oauth'),
      ['api', 'heihei-grok-oauth'],
    )
    expect(logoutResponse.status).toBe(200)
    await expect(heiheiGrokOAuthService.loadTokens()).resolves.toBeNull()
  })
})
