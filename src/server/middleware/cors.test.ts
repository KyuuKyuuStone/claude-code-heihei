import { describe, expect, it } from 'bun:test'
import { corsHeaders, resolveCors } from './cors'

describe('corsHeaders', () => {
  it('allows localhost browser origins', () => {
    expect(corsHeaders('http://127.0.0.1:1420')['Access-Control-Allow-Origin']).toBe('http://127.0.0.1:1420')
    expect(corsHeaders('http://localhost:3000')['Access-Control-Allow-Origin']).toBe('http://localhost:3000')
  })

  it('echoes explicit origins for non-local responses', () => {
    expect(corsHeaders('https://example.com')['Access-Control-Allow-Origin']).toBe('https://example.com')
  })

  it('echoes arbitrary origins in raw header helper', () => {
    expect(corsHeaders('https://example.com')['Access-Control-Allow-Origin']).toBe('https://example.com')
    expect(corsHeaders(null)['Access-Control-Allow-Origin']).toBe('http://localhost:3000')
  })
})

describe('resolveCors', () => {
  it('rejects non-local origins', async () => {
    const result = await resolveCors('https://example.com', 'http://127.0.0.1:3456')

    expect(result).toEqual({
      allowed: false,
      rejected: true,
      headers: {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      },
    })
  })

  it('rejects non-local browser origins', async () => {
    const result = await resolveCors('https://blocked.example.com', 'http://192.168.0.20:3456')

    expect(result).toEqual({
      allowed: false,
      rejected: true,
      headers: {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      },
    })
  })

  it('keeps trusted local desktop origins allowed', async () => {
    for (const origin of ['file://']) {
      const result = await resolveCors(origin, 'http://192.168.0.20:3456')

      expect(result.allowed).toBe(true)
      expect(result.rejected).toBe(false)
      expect(result.headers['Access-Control-Allow-Origin']).toBe(origin)
    }
  })

  it('keeps loopback browser origins allowed', async () => {
    for (const origin of ['http://localhost:3000', 'http://127.0.0.1:2024', 'http://127.0.1.1:2024', 'http://[::1]:5173']) {
      const result = await resolveCors(origin, 'http://192.168.0.20:3456')

      expect(result.allowed).toBe(true)
      expect(result.rejected).toBe(false)
      expect(result.headers['Access-Control-Allow-Origin']).toBe(origin)
    }
  })

  it('keeps missing origins allowed', async () => {
    const result = await resolveCors(null, 'http://192.168.0.20:3456')

    expect(result.allowed).toBe(true)
    expect(result.rejected).toBe(false)
    expect(result.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000')
  })

  it('does not keep LAN browser origins allowed', async () => {
    for (const origin of ['http://192.168.0.20:2024', 'http://10.0.0.5:5173', 'http://127.example.com:5173', 'http://127.bad.0.1:5173', 'not-a-url']) {
      const result = await resolveCors(origin, 'http://192.168.0.20:3456')

      expect(result.allowed).toBe(false)
      expect(result.rejected).toBe(true)
      expect(result.headers['Access-Control-Allow-Origin']).toBeUndefined()
    }
  })

  it('does not keep retired Tauri origins allowed', async () => {
    for (const origin of ['http://tauri.localhost', 'https://tauri.localhost', 'tauri://localhost']) {
      const result = await resolveCors(origin, 'http://192.168.0.20:3456')

      expect(result.allowed).toBe(false)
      expect(result.rejected).toBe(true)
      expect(result.headers['Access-Control-Allow-Origin']).toBeUndefined()
    }
  })

  it('does not trust non-local same-origin requests unless explicitly configured', async () => {
    const result = await resolveCors('http://192.168.0.20:3456', 'http://192.168.0.20:3456')

    expect(result.allowed).toBe(false)
    expect(result.rejected).toBe(true)
    expect(result.headers['Access-Control-Allow-Origin']).toBeUndefined()
  })

})
