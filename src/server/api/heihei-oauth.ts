/**
 * Heihei（Claude 官方登录）OAuth 回调处理器。
 *
 * 登录入口（POST /api/heihei-oauth/start 等 REST 端点）已随桌面端三官方登录特性
 * 一起删除（用户拍板「干净删掉」）；这里**只保留浏览器 redirect 回调**，
 * 它是 index.ts 的 `/callback` 路由目标，仍是活跃运行时路径。
 * token 的刷新/读取走 heiheiOAuthService（会话/定时任务/供应商运行时都在用）。
 */
import { heiheiOAuthService } from '../services/heiheiOAuthService.js'

function html(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

export async function handleHeiheiOAuthCallback(url: URL): Promise<Response> {
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const error = url.searchParams.get('error')

  if (error) {
    return html(renderCallbackPage(false, `OAuth provider returned: ${error}`))
  }
  if (!code || !state) {
    return html(renderCallbackPage(false, 'Missing code or state parameter'))
  }

  try {
    await heiheiOAuthService.completeSession(code, state)
    return html(renderCallbackPage(true, null))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return html(renderCallbackPage(false, msg))
  }
}

function renderCallbackPage(success: boolean, errorMsg: string | null): string {
  if (success) {
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>Login Success</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fafafa;color:#333}.card{text-align:center;padding:40px;background:white;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.06)}h1{color:#16a34a;margin:0 0 12px}p{color:#666}</style>
</head><body><div class="card"><h1>✓ Login Successful</h1><p>You can close this window and return to Claude Code Heihei.</p></div>
<script>setTimeout(() => window.close(), 1500)</script>
</body></html>`
  }
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Login Failed</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fafafa;color:#333}.card{text-align:center;padding:40px;background:white;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.06)}h1{color:#dc2626;margin:0 0 12px}pre{color:#666;white-space:pre-wrap;word-break:break-word;text-align:left;background:#f5f5f5;padding:12px;border-radius:6px}</style>
</head><body><div class="card"><h1>✗ Login Failed</h1><pre>${escapeHtml(errorMsg ?? 'Unknown error')}</pre></div>
</body></html>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
