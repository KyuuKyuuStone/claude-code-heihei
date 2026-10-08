import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ServantSessionModal } from './ServantSessionModal'
import { servantsApi, type ServantInfo } from '../../api/servants'
import { useSettingsStore } from '../../stores/settingsStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useProviderStore } from '../../stores/providerStore'
import { useTabStore } from '../../stores/tabStore'
import { useChatStore } from '../../stores/chatStore'
import { useServantStore } from '../../stores/servantStore'

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

function servant(partial: Partial<ServantInfo> & { sessionId: string }): ServantInfo {
  return {
    enabled: true,
    updatedAt: 1,
    title: partial.sessionId,
    running: false,
    turnInProgress: false,
    ...partial,
  }
}

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
  useSessionStore.setState({
    createSession: vi.fn().mockResolvedValue('new-session'),
    sessions: [],
  })
  useTabStore.setState({ openTab: vi.fn() })
  useChatStore.setState({ connectToSession: vi.fn() })
  useServantStore.setState({ bySessionId: {} })
}

/** 高级选项默认折叠：断言运行配置前先展开。 */
function openAdvanced() {
  fireEvent.click(screen.getByRole('button', { name: /高级选项/ }))
}

beforeEach(() => {
  seedStores()
  vi.mocked(servantsApi.set).mockClear()
  vi.mocked(servantsApi.set).mockResolvedValue({
    servant: { sessionId: 'new-session', enabled: true, updatedAt: 1 },
  })
})

describe('ServantSessionModal 创建路径', () => {
  it('首屏突出身份与行业，运行配置默认收起在高级选项内', () => {
    render(<ServantSessionModal open mode="create" workDir="D:/proj" onClose={vi.fn()} />)

    // 身份二选一 + 行业选择
    expect(screen.getByRole('button', { name: /员工/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('你要做什么？')).toBeInTheDocument()
    // 高级选项默认折叠：折叠状态下不渲染运行配置字段
    expect(screen.queryByLabelText('服务商')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('大模型')).not.toBeInTheDocument()

    openAdvanced()
    expect(screen.getByLabelText('服务商')).toBeInTheDocument()
    expect(screen.getByLabelText('思考强度')).toBeInTheDocument()
  })

  it('选行业后展示该行业首批角色卡片，并可展开其他角色', () => {
    render(<ServantSessionModal open mode="create" workDir="D:/proj" onClose={vi.fn()} />)

    // 未选行业：轻量引导空态
    expect(screen.getByText('选择一个方向，看看适合的角色')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('你要做什么？'), { target: { value: 'software' } })

    // 首批 4 张卡片（软件开发含旧角色，文案沿用既有 i18n）
    expect(screen.getByRole('button', { name: /^后端/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /前端/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /测试/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /代码审查/ })).toBeInTheDocument()
    // 第 5 个「设计师」不在首批
    expect(screen.queryByRole('button', { name: /设计师/ })).not.toBeInTheDocument()
    // 架构师只在四个架构节点介入，排在首批之外
    expect(screen.queryByRole('button', { name: /架构师/ })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /查看其他角色/ }))
    expect(screen.getByRole('button', { name: /设计师/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /架构师/ })).toBeInTheDocument()
  })

  it('角色卡片只显示「负责」段首句，完整四段文案进职责输入框', () => {
    render(<ServantSessionModal open mode="create" workDir="D:/proj" onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('你要做什么？'), { target: { value: 'software' } })

    // 卡片摘要 = 负责段首句（截到首个句末标点），不出现边界/交付/汇报段
    expect(
      screen.getByText('代码变更需要独立检查正确性、可维护性、安全隐患或与项目约定的一致性时派给代码审查'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/不替开发直接改代码/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /代码审查/ }))
    const box = screen.getByLabelText('这个角色负责什么') as HTMLTextAreaElement
    expect(box.value.split('\n')).toHaveLength(4)
    expect(box.value.startsWith('负责：')).toBe(true)
    expect(box.value).toContain('不负责：')
    expect(box.value).toContain('交付：')
    expect(box.value).toContain('汇报：')
  })

  it('选模板回填角色名与职责，创建时写入中文正名', async () => {
    render(<ServantSessionModal open mode="create" workDir="D:/proj" onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('你要做什么？'), { target: { value: 'software' } })
    fireEvent.click(screen.getByRole('button', { name: /代码审查/ }))

    expect(screen.getByLabelText('角色名称')).toHaveValue('代码审查')
    // 回填完整四段职责文案（统一格式：负责/不负责/交付/汇报）
    const desc = (screen.getByLabelText('这个角色负责什么') as HTMLTextAreaElement).value
    expect(desc.split('\n')).toHaveLength(4)
    expect(desc.startsWith('负责：代码变更需要独立检查正确性')).toBe(true)
    expect(desc).toContain('\n不负责：')
    expect(desc).toContain('\n交付：')
    expect(desc).toContain('\n汇报：')

    fireEvent.click(screen.getByRole('button', { name: '创建协作会话' }))
    await waitFor(() => expect(servantsApi.set).toHaveBeenCalled())
    expect(useSessionStore.getState().createSession).toHaveBeenCalledWith(
      'D:/proj',
      { permissionMode: 'bypassPermissions' },
    )
    expect(vi.mocked(servantsApi.set)).toHaveBeenCalledWith(
      'new-session',
      expect.objectContaining({
        role: '代码审查',
        enabled: true,
        supervisor: false,
        runtimeProviderId: 'prov-1',
        runtimeModelId: 'kimi-k2',
        effortLevel: 'high',
      }),
    )
    expect(useTabStore.getState().openTab).toHaveBeenCalledWith('new-session', '代码审查')
  })

  it('新建员工未填角色名时禁用提交并就地提示', () => {
    render(<ServantSessionModal open mode="create" workDir="D:/proj" onClose={vi.fn()} />)

    expect(screen.getByText('请选择一个角色，或自己定义角色名称')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '创建协作会话' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: '自己定义角色' }))
    expect(screen.getByLabelText('角色名称')).toHaveValue('')
  })

  it('新建主管无需角色名即可提交', async () => {
    render(<ServantSessionModal open mode="create" workDir="D:/proj" onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '主管' }))
    fireEvent.click(screen.getByRole('button', { name: '创建协作会话' }))

    await waitFor(() => expect(servantsApi.set).toHaveBeenCalled())
    expect(vi.mocked(servantsApi.set)).toHaveBeenCalledWith(
      'new-session',
      expect.objectContaining({ supervisor: true }),
    )
  })

  it('高级选项折叠与否不改变提交值', async () => {
    render(<ServantSessionModal open mode="create" workDir="D:/proj" onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('你要做什么？'), { target: { value: 'software' } })
    fireEvent.click(screen.getByRole('button', { name: /^后端/ }))

    // 展开高级 → 保持默认「完全执行」，再收起
    openAdvanced()
    fireEvent.click(screen.getByRole('button', { name: /高级选项/ }))

    fireEvent.click(screen.getByRole('button', { name: '创建协作会话' }))
    await waitFor(() => expect(servantsApi.set).toHaveBeenCalled())

    const payload = vi.mocked(servantsApi.set).mock.calls[0]?.[1]
    expect(payload?.constraint).toBeUndefined()
    expect(payload?.writeDirs).toBeUndefined()
    expect(payload?.runtimeProviderId).toBe('prov-1')
  })

  it('创建成功但登记失败时不重复创建会话，重试只做登记', async () => {
    vi.mocked(servantsApi.set).mockRejectedValueOnce(new Error('register failed'))
    render(<ServantSessionModal open mode="create" workDir="D:/proj" onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('你要做什么？'), { target: { value: 'software' } })
    fireEvent.click(screen.getByRole('button', { name: /^后端/ }))
    fireEvent.click(screen.getByRole('button', { name: '创建协作会话' }))

    await waitFor(() => {
      expect(screen.getByText(/会话已创建，但协作身份登记失败/)).toBeInTheDocument()
    })
    expect(useSessionStore.getState().createSession).toHaveBeenCalledTimes(1)

    // 重试：只再登记一次，绝不创建第二个会话
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(servantsApi.set).toHaveBeenCalledTimes(2))
    expect(useSessionStore.getState().createSession).toHaveBeenCalledTimes(1)
  })
})

describe('ServantSessionModal 编辑路径', () => {
  it('按旧 role 反推行业并保留持久化 description 原文', () => {
    // 设计师在 software 行业但不在首批：必须仍被识别，不能按自定义覆盖存档
    useServantStore.setState({
      bySessionId: {
        s1: servant({ sessionId: 's1', role: '设计师', description: '我的自定义职责描述' }),
      },
    })
    render(<ServantSessionModal open mode="edit" sessionId="s1" onClose={vi.fn()} />)

    expect(screen.getByLabelText('你要做什么？')).toHaveValue('software')
    expect(screen.getByLabelText('角色名称')).toHaveValue('设计师')
    expect(screen.getByLabelText('这个角色负责什么')).toHaveValue('我的自定义职责描述')
  })

  it('未知自定义角色回退到通用自定义并原样保留', () => {
    useServantStore.setState({
      bySessionId: {
        s1: servant({ sessionId: 's1', role: '我的角色', description: '手写职责' }),
      },
    })
    render(<ServantSessionModal open mode="edit" sessionId="s1" onClose={vi.fn()} />)

    expect(screen.getByLabelText('你要做什么？')).toHaveValue('custom')
    expect(screen.getByLabelText('角色名称')).toHaveValue('我的角色')
    expect(screen.getByLabelText('这个角色负责什么')).toHaveValue('手写职责')
  })

  it('花名册未就绪时不渲染空表单（防覆盖原身份）', () => {
    useServantStore.setState({ bySessionId: {} })
    render(<ServantSessionModal open mode="edit" sessionId="s1" onClose={vi.fn()} />)

    expect(screen.getByText('正在加载原设置…')).toBeInTheDocument()
    expect(screen.queryByLabelText('你要做什么？')).not.toBeInTheDocument()
  })

  it('从受限档切回完全执行时显式发送 constraint: null', async () => {
    useServantStore.setState({
      bySessionId: {
        s1: servant({ sessionId: 's1', role: '后端', constraint: 'readonly' }),
      },
    })
    render(<ServantSessionModal open mode="edit" sessionId="s1" onClose={vi.fn()} />)

    openAdvanced()
    expect(screen.getByLabelText('约束档位')).toHaveValue('readonly')
    fireEvent.change(screen.getByLabelText('约束档位'), { target: { value: '' } })

    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() => expect(servantsApi.set).toHaveBeenCalled())
    expect(vi.mocked(servantsApi.set)).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ constraint: null }),
    )
  })

  it('原本完全执行、保持默认时不发送 constraint 字段（继承语义）', async () => {
    useServantStore.setState({
      bySessionId: { s1: servant({ sessionId: 's1', role: '后端' }) },
    })
    render(<ServantSessionModal open mode="edit" sessionId="s1" onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() => expect(servantsApi.set).toHaveBeenCalled())
    const payload = vi.mocked(servantsApi.set).mock.calls[0]?.[1]
    expect(payload?.constraint).toBeUndefined()
  })

  it('同工作目录已有主管时禁用主管身份切换并提示冲突', () => {
    useSessionStore.setState({
      sessions: [{
        id: 's1', title: '员工', createdAt: '2026-01-01', modifiedAt: '2026-01-01',
        messageCount: 0, projectPath: 'D:/proj', workDir: 'D:/proj', workDirExists: true,
      }],
    })
    useServantStore.setState({
      bySessionId: {
        s1: servant({ sessionId: 's1', role: '后端', workDir: 'D:/proj' }),
        boss: servant({ sessionId: 'boss', role: '主管', supervisor: true, workDir: 'D:/proj' }),
      },
    })
    render(<ServantSessionModal open mode="edit" sessionId="s1" onClose={vi.fn()} />)

    expect(screen.getByText('当前工作目录已有主管，请先到该会话取消任命')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '主管' })).toBeDisabled()
  })

  it('编辑态回显会话持久化的运行配置', () => {
    useSessionStore.setState({
      sessions: [{
        id: 's1', title: '写作会话', createdAt: '2026-01-01', modifiedAt: '2026-01-01',
        messageCount: 0, projectPath: 'D:/proj', workDir: 'D:/proj', workDirExists: true,
        runtimeProviderId: 'prov-1', runtimeModelId: 'kimi-max', effortLevel: 'low',
      }],
    })
    useServantStore.setState({
      bySessionId: { s1: servant({ sessionId: 's1', role: '写作' }) },
    })
    render(<ServantSessionModal open mode="edit" sessionId="s1" onClose={vi.fn()} />)

    openAdvanced()
    expect(screen.getByLabelText('大模型')).toHaveValue('kimi-max')
    expect(screen.getByLabelText('思考强度')).toHaveValue('low')
  })

  it('目录白名单空值时禁用提交并就地提示', () => {
    useServantStore.setState({
      bySessionId: { s1: servant({ sessionId: 's1', role: '后端', constraint: 'whitelist', writeDirs: ['D:/seed'] }) },
    })
    render(<ServantSessionModal open mode="edit" sessionId="s1" onClose={vi.fn()} />)

    openAdvanced()
    const editor = screen.getByLabelText('可写目录（每行一个绝对路径）')
    fireEvent.change(editor, { target: { value: '   ' } })

    expect(screen.getByText('至少填写一个绝对路径')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存设置' })).toBeDisabled()
  })
})

describe('ServantSessionModal i18n', () => {
  it('英文界面下行业与角色展示名走本地化，角色名仍是中文正名', () => {
    useSettingsStore.setState({ locale: 'en' })
    render(<ServantSessionModal open mode="create" workDir="D:/proj" onClose={vi.fn()} />)

    const industrySelect = screen.getByLabelText('What do you do?')
    expect(within(industrySelect).getByRole('option', { name: 'Software development' })).toHaveValue('software')

    fireEvent.change(industrySelect, { target: { value: 'software' } })
    fireEvent.click(screen.getByRole('button', { name: /Code Review/ }))

    // value 仍是中文正名（稳定标识，匹配既有存档）
    expect(screen.getByLabelText('Role name')).toHaveValue('代码审查')
  })
})

describe('ServantSessionModal 编辑路径 · 目标不在花名册（缺陷 #2 永久加载态）', () => {
  it('未登记会话放行表单，提交即完成登记（v1.7.3 裁决：upsert 首次登记）', async () => {
    seedStores()
    const onClose = vi.fn()
    render(<ServantSessionModal open mode="edit" sessionId="ghost-session" onClose={onClose} />)

    // 引导语（不再是失败语 + 伪重试），表单放行
    expect(await screen.findByText('该会话尚未登记为协作会话；填写以下信息并保存即完成登记。')).toBeInTheDocument()
    expect(screen.queryByText(/正在加载原设置/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
    const submit = screen.getByRole('button', { name: '保存设置' })
    expect(submit).toBeEnabled()

    // 提交走既有 upsert → 首次登记（服务端流程），弹窗关闭
    await act(async () => {
      fireEvent.click(submit)
    })
    await waitFor(() => {
      expect(vi.mocked(servantsApi.set)).toHaveBeenCalledWith(
        'ghost-session',
        expect.objectContaining({ enabled: true }),
      )
      expect(onClose).toHaveBeenCalled()
    })
  })

  it('花名册拉取失败时给出失败态与重试，重试成功后转为未登记引导', async () => {
    seedStores()
    vi.mocked(servantsApi.list).mockRejectedValueOnce(new Error('roster boom'))
    render(<ServantSessionModal open mode="edit" sessionId="ghost-session" onClose={vi.fn()} />)

    // 拉取失败（可重试）与「未登记（永久）」区分开
    expect(await screen.findByText('花名册读取失败，请重试。')).toBeInTheDocument()
    const retry = screen.getByRole('button', { name: '重试' })

    // 重试成功（空花名册）→ 未登记引导 + 表单放行
    vi.mocked(servantsApi.list).mockResolvedValue({ servants: [] })
    await act(async () => {
      fireEvent.click(retry)
    })
    expect(await screen.findByText(/尚未登记为协作会话/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存设置' })).toBeEnabled()
  })

  it('edit 模式目标在花名册：正常渲染表单，不误伤', async () => {
    seedStores()
    useServantStore.setState({
      bySessionId: { 'sess-1': servant({ sessionId: 'sess-1', role: '前端工程师' }) },
    })
    render(<ServantSessionModal open mode="edit" sessionId="sess-1" onClose={vi.fn()} />)

    expect(await screen.findByText('身份')).toBeInTheDocument()
    expect(screen.queryByText(/未在协作花名册/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存设置' })).toBeEnabled()
  })
})
