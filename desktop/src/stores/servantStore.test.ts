import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiListMock = vi.hoisted(() => vi.fn())
const apiSetMock = vi.hoisted(() => vi.fn())
const apiRemoveMock = vi.hoisted(() => vi.fn())
const apiSendMock = vi.hoisted(() => vi.fn())

vi.mock('../api/servants', () => ({
  servantsApi: {
    list: apiListMock,
    set: apiSetMock,
    remove: apiRemoveMock,
    sendMessage: apiSendMock,
  },
}))

import type { ServantInfo } from '../api/servants'
import { useServantStore } from './servantStore'

function makeServant(overrides: Partial<ServantInfo> = {}): ServantInfo {
  return {
    sessionId: 'sess-1',
    role: '后端',
    enabled: true,
    updatedAt: 1000,
    title: 'API 服务',
    running: false,
    ...overrides,
  }
}

describe('servantStore', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    useServantStore.setState({ bySessionId: {}, isLoading: false })
  })

  it('fetches the roster into a sessionId map', async () => {
    apiListMock.mockResolvedValue({
      servants: [makeServant(), makeServant({ sessionId: 'sess-2', role: '前端' })],
    })

    await useServantStore.getState().fetchServants()

    const map = useServantStore.getState().bySessionId
    expect(Object.keys(map)).toHaveLength(2)
    expect(map['sess-1']?.role).toBe('后端')
    expect(map['sess-2']?.role).toBe('前端')
    expect(useServantStore.getState().isLoading).toBe(false)
  })

  it('removes the entry when setServant disables it', async () => {
    useServantStore.setState({ bySessionId: { 'sess-1': makeServant() } })
    apiSetMock.mockResolvedValue({})
    apiListMock.mockResolvedValue({ servants: [] })

    await useServantStore
      .getState()
      .setServant('sess-1', { role: '后端', enabled: false })

    expect(apiSetMock).toHaveBeenCalledWith('sess-1', {
      role: '后端',
      enabled: false,
    })
    expect(useServantStore.getState().bySessionId['sess-1']).toBeUndefined()
  })

  it('refreshes the roster after enabling a servant', async () => {
    apiSetMock.mockResolvedValue({})
    apiListMock.mockResolvedValue({ servants: [makeServant()] })

    await useServantStore
      .getState()
      .setServant('sess-1', { role: '后端', enabled: true })

    expect(useServantStore.getState().bySessionId['sess-1']?.role).toBe('后端')
  })

  it('removes a servant', async () => {
    useServantStore.setState({ bySessionId: { 'sess-1': makeServant() } })
    apiRemoveMock.mockResolvedValue({ ok: true })

    await useServantStore.getState().removeServant('sess-1')

    expect(apiRemoveMock).toHaveBeenCalledWith('sess-1')
    expect(useServantStore.getState().bySessionId).toEqual({})
  })
})
