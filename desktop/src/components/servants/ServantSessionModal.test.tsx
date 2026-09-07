import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ServantSessionModal } from './ServantSessionModal'
import { servantsApi } from '../../api/servants'
import { useSettingsStore } from '../../stores/settingsStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useProviderStore } from '../../stores/providerStore'
import { useTabStore } from '../../stores/tabStore'
import { useChatStore } from '../../stores/chatStore'
import { useHeiheiOAuthStore } from '../../stores/heiheiOAuthStore'
import { useHeiheiOpenAIOAuthStore } from '../../stores/heiheiOpenAIOAuthStore'
import { useHeiheiGrokOAuthStore } from '../../stores/heiheiGrokOAuthStore'

vi.mock('../../api/servants', () => ({
  servantsApi: {
    list: vi.fn().mockResolvedValue({ servants: [] }),
    set: vi.fn().mockResolvedValue({
      servant: { sessionId: 'new-session', enabled: true, updatedAt: 1 },
    }),
    remove: vi.fn().mockResolvedValue({ ok: true }),
    sendMessage: vi.fn().mockResolvedValue({ ok: true }),
  },
}))

function seedStores() {
  useSettingsStore.setState({
    locale: 'zh',
    currentModel: { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', description: '', context: '' },
    availableModels: [],
    effortLevel: 'high',
    activeProviderName: null,
  })
  useProviderStore.setState({
    providers: [{
      id: 'prov-1',
      name: 'Kimi',
      presetId: '',
      apiKey: '',
      baseUrl: 'https://api.kimi.example',
      apiFormat: 'anthropic',
      models: { main: 'kimi-k2', haiku: 'kimi-lite', sonnet: 'kimi-k2', opus: 'kimi-max' },
    }],
    activeId: 'prov-1',
    fetchProviders: vi.fn(),
  })
  useHeiheiOAuthStore.setState({ fetchStatus: vi.fn() })
  useHeiheiOpenAIOAuthStore.setState({ fetchStatus: vi.fn() })
  useHeiheiGrokOAuthStore.setState({ fetchStatus: vi.fn() })
  useSessionStore.setState({
    createSession: vi.fn().mockResolvedValue('new-session'),
    sessions: [],
  })
  useTabStore.setState({ openTab: vi.fn() })
  useChatStore.setState({ connectToSession: vi.fn() })
}

beforeEach(() => {
  seedStores()
})

describe('ServantSessionModal', () => {
  it('renders the three sections and runtime fields', () => {
    render(<ServantSessionModal open mode="create" workDir="D:/proj" onClose={vi.fn()} />)

    expect(screen.getAllByText('角色').length).toBeGreaterThan(0)
    expect(screen.getByText('运行配置')).toBeInTheDocument()
    expect(screen.getByText('身份')).toBeInTheDocument()
    expect(screen.getByLabelText('服务商')).toBeInTheDocument()
    expect(screen.getByLabelText('大模型')).toBeInTheDocument()
    expect(screen.getByLabelText('思考强度')).toBeInTheDocument()
  })

  it('fills role and description from a preset including personality wording', () => {
    render(<ServantSessionModal open mode="create" workDir="D:/proj" onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('预置角色'), { target: { value: '代码审查' } })

    expect(screen.getByLabelText('角色')).toHaveValue('代码审查')
    expect(screen.getByLabelText('角色特性')).toHaveValue(
      '严格挑剔地审查代码质量、安全与可维护性，只报真问题，输出问题清单与修改建议',
    )
  })

  it('submits the selected runtime (provider/model/effort) when creating', async () => {
    render(<ServantSessionModal open mode="create" workDir="D:/proj" onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '创建' }))

    await waitFor(() => {
      expect(servantsApi.set).toHaveBeenCalled()
    })
    expect(useSessionStore.getState().createSession).toHaveBeenCalledWith(
      'D:/proj',
      { permissionMode: 'bypassPermissions' },
    )
    expect(vi.mocked(servantsApi.set)).toHaveBeenCalledWith(
      'new-session',
      expect.objectContaining({
        enabled: true,
        runtimeProviderId: 'prov-1',
        runtimeModelId: 'kimi-k2',
        effortLevel: 'high',
      }),
    )
    // 标签页标题使用角色名而不是通用“新建会话”（未填角色时才回退）
    expect(useTabStore.getState().openTab).toHaveBeenCalledWith('new-session', '新建会话')
  })

  it('pre-fills the session persisted runtime in edit mode', () => {
    useSessionStore.setState({
      sessions: [{
        id: 's1',
        title: '写作会话',
        createdAt: '2026-01-01',
        modifiedAt: '2026-01-01',
        messageCount: 0,
        projectPath: 'D:/proj',
        workDir: 'D:/proj',
        workDirExists: true,
        runtimeProviderId: 'prov-1',
        runtimeModelId: 'kimi-max',
        effortLevel: 'low',
      }],
    })

    render(<ServantSessionModal open mode="edit" sessionId="s1" onClose={vi.fn()} />)

    expect(screen.getByLabelText('大模型')).toHaveValue('kimi-max')
    expect(screen.getByLabelText('思考强度')).toHaveValue('low')
  })
})
