// desktop/src/api/heiheiOAuth.ts

import { api, getBaseUrl } from './client'

export type HeiheiOAuthStatus =
  | { loggedIn: false }
  | {
      loggedIn: true
      expiresAt: number | null
      scopes: string[]
      subscriptionType: 'pro' | 'max' | 'team' | 'enterprise' | null
    }

function currentServerPort(): number {
  const port = new URL(getBaseUrl()).port
  const parsed = Number.parseInt(port, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Cannot determine server port from baseUrl: ${getBaseUrl()}`)
  }
  return parsed
}

export const heiheiOAuthApi = {
  start() {
    return api.post<{ authorizeUrl: string; state: string }>(
      '/api/heihei-oauth/start',
      { serverPort: currentServerPort() },
    )
  },

  status() {
    return api.get<HeiheiOAuthStatus>('/api/heihei-oauth')
  },

  logout() {
    return api.delete<{ ok: true }>('/api/heihei-oauth')
  },
}
