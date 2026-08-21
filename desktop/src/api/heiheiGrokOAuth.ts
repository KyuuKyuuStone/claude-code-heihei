import { api, getBaseUrl } from './client'

export type HeiheiGrokOAuthStatus =
  | { loggedIn: false }
  | {
      loggedIn: true
      expiresAt: number | null
      email: string | null
    }

function currentServerPort(): number {
  const port = new URL(getBaseUrl()).port
  const parsed = Number.parseInt(port, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Cannot determine server port from baseUrl: ${getBaseUrl()}`)
  }
  return parsed
}

export const heiheiGrokOAuthApi = {
  start() {
    return api.post<{ authorizeUrl: string; state: string }>(
      '/api/heihei-grok-oauth/start',
      { serverPort: currentServerPort() },
    )
  },

  status() {
    return api.get<HeiheiGrokOAuthStatus>('/api/heihei-grok-oauth')
  },

  successUrl() {
    return `${getBaseUrl()}/api/heihei-grok-oauth/success`
  },

  logout() {
    return api.delete<{ ok: true }>('/api/heihei-grok-oauth')
  },
}
