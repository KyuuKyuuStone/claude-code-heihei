import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../../../api/client'
import { ShedPayloadAction } from './ShedPayloadAction'

const { shedPayload } = vi.hoisted(() => ({ shedPayload: vi.fn() }))
vi.mock('../../../api/sessions', () => ({ sessionsApi: { shedPayload } }))

const okResponse = {
  ok: true as const,
  sessionId: 'oversized-session',
  bytesBefore: 5 * 1024 * 1024,
  bytesAfter: 1 * 1024 * 1024,
  mediaBlocksRemoved: 2,
  textBlocksTruncated: 0,
  messagesTouched: 3,
  backupPath: '/tmp/backup.jsonl',
}

afterEach(() => {
  shedPayload.mockReset()
})

describe('ShedPayloadAction', () => {
  it('calls the shed endpoint for its session and reports the freed bytes', async () => {
    shedPayload.mockResolvedValue(okResponse)
    render(<ShedPayloadAction sessionId="oversized-session" />)

    fireEvent.click(screen.getByTestId('shed-payload-action'))

    await waitFor(() => {
      expect(screen.getByText(/4\.0 MB/)).toBeTruthy()
    })
    expect(shedPayload).toHaveBeenCalledWith('oversized-session')
    // 成功后按钮消失 ⇒ 该条错误不再可点（用户改自己重发，不自动重试）。
    expect(screen.queryByTestId('shed-payload-action')).toBeNull()
  })

  it('shows a disabled running state while the request is in flight', async () => {
    let resolveShed: (value: typeof okResponse) => void = () => {}
    shedPayload.mockImplementation(() => new Promise((resolve) => {
      resolveShed = resolve
    }))
    render(<ShedPayloadAction sessionId="oversized-session" />)

    fireEvent.click(screen.getByTestId('shed-payload-action'))

    await waitFor(() => {
      expect((screen.getByTestId('shed-payload-action') as HTMLButtonElement).disabled).toBe(true)
    })
    expect(document.querySelector('[data-shed-payload="running"]')).toBeTruthy()

    await act(async () => {
      resolveShed(okResponse)
    })
    await waitFor(() => {
      expect(screen.getByText(/4\.0 MB/)).toBeTruthy()
    })
  })

  it('surfaces the server message when there is nothing to shed (409)', async () => {
    shedPayload.mockRejectedValue(new ApiError(409, {
      error: 'NOTHING_TO_SHED',
      message: '该会话没有可清理的内容',
    }))
    render(<ShedPayloadAction sessionId="oversized-session" />)

    fireEvent.click(screen.getByTestId('shed-payload-action'))

    await waitFor(() => {
      expect(screen.getByText('该会话没有可清理的内容')).toBeTruthy()
    })
    // 409 是终态：不给重试（重试必然同样结果）。
    expect(screen.queryByTestId('shed-payload-action')).toBeNull()
  })

  it('keeps a retry available when the repair itself fails', async () => {
    shedPayload.mockRejectedValueOnce(new ApiError(500, { message: '内部错误' }))
    render(<ShedPayloadAction sessionId="oversized-session" />)

    fireEvent.click(screen.getByTestId('shed-payload-action'))

    await waitFor(() => {
      expect(document.querySelector('[data-shed-payload="failed"]')?.textContent).toContain('内部错误')
    })
    const retry = screen.getByTestId('shed-payload-action')
    expect((retry as HTMLButtonElement).disabled).toBe(false)

    // 再点一次走通 ⇒ 失败态可恢复。
    shedPayload.mockResolvedValue(okResponse)
    fireEvent.click(retry)
    await waitFor(() => {
      expect(screen.getByText(/4\.0 MB/)).toBeTruthy()
    })
  })
})
