import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

  it('localizes preset labels and descriptions while keeping the canonical role name', () => {
    useSettingsStore.setState({ locale: 'en' })
    render(<ServantSessionModal open mode="create" workDir="D:/proj" onClose={vi.fn()} />)

    // 选项标签随语言走，value 仍是中文正名（稳定标识，匹配既有存档）
    const presetSelect = screen.getByLabelText('Role preset')
    expect(within(presetSelect).getByRole('option', { name: 'Code Review' })).toHaveValue('代码审查')

    fireEvent.change(presetSelect, { target: { value: '代码审查' } })

    expect(screen.getByLabelText('Role')).toHaveValue('代码审查')
    expect(screen.getByLabelText('Role description')).toHaveValue(
      'Reviews code quality, security and maintainability with a critical eye; only reports real issues, delivering a problem list with fix suggestions',
    )
  })

  it('explains that disabling serve only pauses work while roster removal ends the identity', () => {
    render(<ServantSessionModal open mode="create" workDir="D:/proj" onClose={vi.fn()} />)

    expect(screen.getByText(/只是暂停接活/)).toBeInTheDocument()
    expect(screen.getByText(/从花名册移除则协作身份终止/)).toBeInTheDocument()
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

  // ─── whitelist 约束档（A3）─────────────────────────────────────────────────

  it('shows writeDirs editor only when the whitelist constraint is selected', () => {
    render(<ServantSessionModal open mode="create" workDir="D:/proj" onClose={vi.fn()} />)

    const constraintSelect = screen.getByLabelText('约束档位')
    expect(constraintSelect).toHaveValue('')
    expect(screen.queryByLabelText('可写目录（每行一个绝对路径）')).not.toBeInTheDocument()

    fireEvent.change(constraintSelect, { target: { value: 'whitelist' } })
    expect(screen.getByLabelText('可写目录（每行一个绝对路径）')).toBeInTheDocument()

    fireEvent.change(constraintSelect, { target: { value: '' } })
    expect(screen.queryByLabelText('可写目录（每行一个绝对路径）')).not.toBeInTheDocument()
  })

  it('pre-fills writeDirs with the session working directory in create mode', () => {
    render(<ServantSessionModal open mode="create" workDir="D:/proj" onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('约束档位'), { target: { value: 'whitelist' } })

    expect(screen.getByLabelText('可写目录（每行一个绝对路径）')).toHaveValue('D:/proj')
  })

  it('pre-fills writeDirs from the persisted roster entry in edit mode', async () => {
    useSessionStore.setState({
      sessions: [{
        id: 's1',
        title: '受限员工',
        createdAt: '2026-01-01',
        modifiedAt: '2026-01-01',
        messageCount: 0,
        projectPath: 'D:/proj',
        workDir: 'D:/proj',
        workDirExists: true,
      }],
    })
    const { useServantStore } = await import('../../stores/servantStore')
    useServantStore.setState({
      bySessionId: {
        s1: {
          sessionId: 's1',
          enabled: true,
          constraint: 'whitelist',
          writeDirs: ['D:/safe-area', 'D:/build-out'],
          updatedAt: 1,
          title: '受限员工',
          running: false,
        },
      },
    })

    render(<ServantSessionModal open mode="edit" sessionId="s1" onClose={vi.fn()} />)

    expect(screen.getByLabelText('约束档位')).toHaveValue('whitelist')
    expect(screen.getByLabelText('可写目录（每行一个绝对路径）')).toHaveValue(
      'D:/safe-area\nD:/build-out',
    )
  })

  it('does not overwrite user-edited writeDirs when roster data arrives late (坑③ touched guard)', async () => {
    useSessionStore.setState({
      sessions: [{
        id: 's1',
        title: '员工',
        createdAt: '2026-01-01',
        modifiedAt: '2026-01-01',
        messageCount: 0,
        projectPath: 'D:/proj',
        workDir: 'D:/proj',
        workDirExists: true,
      }],
    })
    const { useServantStore } = await import('../../stores/servantStore')
    useServantStore.setState({ bySessionId: {} })

    render(<ServantSessionModal open mode="edit" sessionId="s1" onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('约束档位'), { target: { value: 'whitelist' } })
    // 档位切换后 workDir 兜底预填，用户随后手动编辑
    const editor = screen.getByLabelText('可写目录（每行一个绝对路径）')
    fireEvent.change(editor, { target: { value: 'D:/user-typed' } })

    // 花名册数据晚到（模拟异步 fetch 完成触发 rerender + 预填 effect）
    useServantStore.setState({
      bySessionId: {
        s1: {
          sessionId: 's1',
          enabled: true,
          constraint: 'whitelist',
          writeDirs: ['D:/late-arrived'],
          updatedAt: 2,
          title: '员工',
          running: false,
        },
      },
    })

    // touched 守卫生效：用户输入不被晚到的持久化数据覆盖
    expect(screen.getByLabelText('可写目录（每行一个绝对路径）')).toHaveValue('D:/user-typed')
  })

  it('submits writeDirs with whitelist and omits them for other constraints', async () => {
    render(<ServantSessionModal open mode="create" workDir="D:/proj" onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('约束档位'), { target: { value: 'whitelist' } })
    fireEvent.change(screen.getByLabelText('可写目录（每行一个绝对路径）'), {
      target: { value: '\n  D:/proj  \n\nD:/out\n' },
    })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))

    await waitFor(() => {
      expect(servantsApi.set).toHaveBeenCalled()
    })
    expect(vi.mocked(servantsApi.set)).toHaveBeenCalledWith(
      'new-session',
      expect.objectContaining({
        constraint: 'whitelist',
        // trim + 去空行
        writeDirs: ['D:/proj', 'D:/out'],
      }),
    )

    // 切回 full 再提交：不带 constraint/writeDirs
    vi.mocked(servantsApi.set).mockClear()
    fireEvent.change(screen.getByLabelText('约束档位'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    await waitFor(() => {
      expect(servantsApi.set).toHaveBeenCalled()
    })
    const secondCall = vi.mocked(servantsApi.set).mock.calls[0]?.[1]
    expect(secondCall?.constraint).toBeUndefined()
    expect(secondCall?.writeDirs).toBeUndefined()
  })
})
