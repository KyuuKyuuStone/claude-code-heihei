import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProviderSettings } from './ProvidersSettings'
import { useProviderStore } from '../../stores/providerStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore } from '../../stores/uiStore'
import type { SavedProvider } from '../../types/provider'

// locale 在每个用例前钉定（afterEach 的 reset 会打回默认 en，模块级 setState 只对首个用例有效）

function makeProvider(overrides: Partial<SavedProvider> = {}): SavedProvider {
  return {
    id: 'prov-1',
    presetId: 'custom',
    name: 'Provider A',
    apiKey: '***',
    baseUrl: 'https://api.example.com',
    apiFormat: 'anthropic',
    models: { main: 'm', haiku: 'h', sonnet: 's', opus: 'o' },
    ...overrides,
  } as SavedProvider
}

beforeEach(() => {
  useSettingsStore.setState({ locale: 'zh' })
})

afterEach(() => {
  useProviderStore.setState(useProviderStore.getInitialState(), true)
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
  useUIStore.setState(useUIStore.getInitialState(), true)
})

describe('ProviderSettings 失败态（v1.7.3 A1/A2）', () => {
  it('shows a failure state with retry instead of the empty state when loading fails', () => {
    const fetchProviders = vi.fn()
    useProviderStore.setState({
      providers: [],
      isLoading: false,
      error: '供应商配置读取失败',
      fetchProviders,
    })

    render(<ProviderSettings />)

    // v1.7.3 A2：失败不再落进「暂无供应商」空态
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('供应商配置读取失败')
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
    expect(screen.queryByText(/暂无/)).not.toBeInTheDocument()
  })

  it('surfaces a toast when deleting a provider fails', async () => {
    const addToast = vi.fn()
    useUIStore.setState({ addToast })
    useProviderStore.setState({
      providers: [makeProvider()],
      providerOrder: ['prov-1'],
      isLoading: false,
      error: null,
      deleteProvider: vi.fn(async () => {
        throw new Error('delete boom')
      }),
    })

    render(<ProviderSettings />)

    const { fireEvent } = await import('@testing-library/react')
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    // 确认弹窗 → 确认删除
    const confirmButtons = screen.getAllByRole('button', { name: '删除' })
    fireEvent.click(confirmButtons[confirmButtons.length - 1]!)

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith(expect.objectContaining({
        type: 'error',
        message: 'delete boom',
      }))
    })
  })
})
