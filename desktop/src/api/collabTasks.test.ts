import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiGet = vi.hoisted(() => vi.fn())
vi.mock('./client', () => ({ api: { get: apiGet } }))

import { collabTasksApi } from './collabTasks'

describe('collabTasksApi', () => {
  beforeEach(() => apiGet.mockReset().mockResolvedValue({ tasks: [], projectDir: '/resolved/project' }))

  it('always scopes the panel list request to a session', async () => {
    await collabTasksApi.listForSession('session/with spaces')
    expect(apiGet).toHaveBeenCalledWith('/api/collab-tasks?forSessionId=session%2Fwith%20spaces')
    expect(String(apiGet.mock.calls[0]?.[0])).toContain('forSessionId=')
  })
})
