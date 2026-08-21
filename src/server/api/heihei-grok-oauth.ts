import {
  GROK_OAUTH_SUCCESS_HTML,
  heiheiGrokOAuthService,
} from '../services/heiheiGrokOAuthService.js'
import { errorResponse } from '../middleware/errorHandler.js'

export async function handleHeiheiGrokOAuthApi(
  req: Request,
  _url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const action = segments[2]
    if (action === 'start' && req.method === 'POST') {
      const session = await heiheiGrokOAuthService.startSession()
      return Response.json({
        authorizeUrl: session.authorizeUrl,
        state: session.state,
      })
    }

    if (action === 'success' && req.method === 'GET') {
      return new Response(GROK_OAUTH_SUCCESS_HTML, {
        headers: {
          'Cache-Control': 'no-store',
          'Content-Type': 'text/html; charset=utf-8',
        },
      })
    }

    if (action === undefined && req.method === 'GET') {
      const tokens = await heiheiGrokOAuthService.ensureFreshTokens()
      if (!tokens) return Response.json({ loggedIn: false })
      return Response.json({
        loggedIn: true,
        expiresAt: tokens.expiresAt,
        email: tokens.email,
      })
    }

    if (action === undefined && req.method === 'DELETE') {
      heiheiGrokOAuthService.dispose()
      await heiheiGrokOAuthService.deleteTokens()
      return Response.json({ ok: true })
    }

    return Response.json({ error: 'Not Found' }, { status: 404 })
  } catch (error) {
    return errorResponse(error)
  }
}
