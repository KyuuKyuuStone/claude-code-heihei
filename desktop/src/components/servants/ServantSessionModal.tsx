import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { TextArea } from '@/components/ui/TextArea'
import { Switch } from '@/components/ui/Switch'
import { SelectField } from '@/components/ui/SelectField'
import { Button } from '@/components/ui/Button'
import { useServantStore } from '../../stores/servantStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useChatStore } from '../../stores/chatStore'
import { useTabStore } from '../../stores/tabStore'
import { useProviderStore } from '../../stores/providerStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useHeiheiOAuthStore } from '../../stores/heiheiOAuthStore'
import { useHeiheiOpenAIOAuthStore } from '../../stores/heiheiOpenAIOAuthStore'
import { useHeiheiGrokOAuthStore } from '../../stores/heiheiGrokOAuthStore'
import { buildProviderChoices, type ProviderChoice } from '../../lib/modelChoices'
import { resolveDefaultRuntimeSelection } from '../../lib/runtimeSelection'
import { useTranslation } from '../../i18n'
import { ROLE_PRESETS, SUPERVISOR_DEFAULT_DESCRIPTION } from './rolePresets'
import type { RuntimeSelection } from '../../types/runtime'
import type { ReasoningEffortLevel } from '../../types/settings'

type Props = {
  open: boolean
  onClose: () => void
  /** create：新建协作会话；edit：修改已有会话的协作身份 */
  mode: 'create' | 'edit'
  /** edit 模式的目标会话 */
  sessionId?: string
  /** create 模式的工作目录 */
  workDir?: string
}

const CLAUDE_OFFICIAL_OPTION_VALUE = ''

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5" aria-hidden="true">
      <span className="text-[12.5px] font-semibold text-[var(--color-text-secondary)]">{children}</span>
      <span className="h-px flex-1 bg-[var(--color-border)]" />
    </div>
  )
}

export function ServantSessionModal({ open, onClose, mode, sessionId, workDir }: Props) {
  const t = useTranslation()
  const { setServant } = useServantStore()
  const existing = useServantStore((s) =>
    sessionId ? s.bySessionId[sessionId] : undefined,
  )
  const existingSession = useSessionStore((s) =>
    sessionId ? s.sessions.find((session) => session.id === sessionId) : undefined,
  )
  const { providers, activeId, fetchProviders } = useProviderStore()
  const {
    currentModel: globalModelId,
    availableModels,
    effortLevel: globalEffortLevel,
    activeProviderName,
  } = useSettingsStore()
  const claudeOAuthStatus = useHeiheiOAuthStore((s) => s.status)
  const fetchClaudeOAuthStatus = useHeiheiOAuthStore((s) => s.fetchStatus)
  const openAIOAuthStatus = useHeiheiOpenAIOAuthStore((s) => s.status)
  const fetchOpenAIOAuthStatus = useHeiheiOpenAIOAuthStore((s) => s.fetchStatus)
  const grokOAuthStatus = useHeiheiGrokOAuthStore((s) => s.status)
  const fetchGrokOAuthStatus = useHeiheiGrokOAuthStore((s) => s.fetchStatus)

  const [role, setRole] = useState(existing?.role || '')
  const [description, setDescription] = useState(existing?.description || '')
  const [serve, setServe] = useState(existing?.enabled ?? true)
  const [supervisor, setSupervisor] = useState(existing?.supervisor ?? false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 运行配置初始值：edit 模式取该会话已持久化的运行时；create 模式取当前全局选择。
  // providers 异步加载完成前先用全局兜底，加载后再校正（用户未手动改过时）。
  const [runtime, setRuntime] = useState<RuntimeSelection>(() => {
    if (mode === 'edit' && existingSession?.runtimeModelId) {
      return {
        providerId: existingSession.runtimeProviderId ?? null,
        modelId: existingSession.runtimeModelId,
        ...(existingSession.effortLevel
          ? { effortLevel: existingSession.effortLevel }
          : {}),
      }
    }
    const settings = useSettingsStore.getState()
    return {
      ...resolveDefaultRuntimeSelection(
        useProviderStore.getState().activeId,
        settings.activeProviderName,
        useProviderStore.getState().providers,
        settings.currentModel?.id,
      ),
      ...(settings.effortLevel ? { effortLevel: settings.effortLevel } : {}),
    }
  })
  const [runtimeTouched, setRuntimeTouched] = useState(false)

  useEffect(() => {
    if (!open) return
    if (providers.length === 0) void fetchProviders()
    void fetchClaudeOAuthStatus()
    void fetchOpenAIOAuthStatus()
    void fetchGrokOAuthStatus()
    // open 时一次性拉取目录数据；依赖里的 fetch 系列是 store 稳定引用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // providers 目录加载完成后（首次为空 → 有数据），未手动改过就刷新预填；
  // edit 模式已有持久化运行时的，以持久化值为准，不被全局默认覆盖
  const hasPersistedRuntime = mode === 'edit' && Boolean(existingSession?.runtimeModelId)
  useEffect(() => {
    if (runtimeTouched || hasPersistedRuntime || providers.length === 0) return
    setRuntime({
      ...resolveDefaultRuntimeSelection(
        activeId,
        activeProviderName,
        providers,
        globalModelId?.id ?? undefined,
      ),
      ...(globalEffortLevel ? { effortLevel: globalEffortLevel } : {}),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers.length, runtimeTouched, hasPersistedRuntime])

  const roleLabels = useMemo(
    () => ({
      main: t('settings.providers.mainModel'),
      haiku: t('settings.providers.haikuModel'),
      sonnet: t('settings.providers.sonnetModel'),
      opus: t('settings.providers.opusModel'),
    }),
    [t],
  )

  const providerChoices = useMemo(
    () => buildProviderChoices(
      providers,
      activeId,
      availableModels,
      t('settings.providers.officialName'),
      t('settings.providers.openaiOfficialName'),
      t('settings.providers.grokOfficialName'),
      roleLabels,
      claudeOAuthStatus?.loggedIn === true,
      openAIOAuthStatus?.loggedIn === true,
      grokOAuthStatus?.loggedIn === true,
    ),
    [activeId, availableModels, providers, roleLabels, t, claudeOAuthStatus, grokOAuthStatus, openAIOAuthStatus],
  )

  const selectedChoice = useMemo(
    () => providerChoices.find((choice) => (choice.providerId ?? '') === (runtime.providerId ?? '')) ?? null,
    [providerChoices, runtime.providerId],
  )
  const selectedModel = useMemo(
    () => selectedChoice?.models.find((model) => model.id === runtime.modelId) ?? null,
    [selectedChoice, runtime.modelId],
  )

  // 与 ModelSelector 一致：目录未知时隐藏 xhigh，已知时按模型声明过滤
  const effortOptions = useMemo<ReasoningEffortLevel[]>(() => {
    const supported = selectedModel?.supportedReasoningEfforts
    if (supported === undefined) {
      return ['low', 'medium', 'high', 'max']
    }
    return supported
  }, [selectedModel])

  // 界面显示与提交落盘保持同一个值：未显式选择时按模型默认/首个支持档位
  const selectedEffort: ReasoningEffortLevel = runtime.effortLevel
    ?? selectedModel?.defaultReasoningEffort
    ?? effortOptions[0]
    ?? 'medium'

  const updateRuntime = (patch: Partial<RuntimeSelection>) => {
    setRuntimeTouched(true)
    setRuntime((current) => {
      const next = { ...current, ...patch }
      if (patch.providerId !== undefined && patch.providerId !== current.providerId) {
        const choice = providerChoices.find(
          (candidate) => (candidate.providerId ?? '') === (next.providerId ?? ''),
        )
        next.modelId = choice?.models[0]?.id ?? next.modelId
        next.effortLevel = undefined
      }
      if (patch.modelId !== undefined && patch.modelId !== current.modelId) {
        next.effortLevel = undefined
      }
      // 思考强度不被新模型支持时回落到模型默认或首个支持档位
      const choice = providerChoices.find(
        (candidate) => (candidate.providerId ?? '') === (next.providerId ?? ''),
      )
      const model = choice?.models.find((candidate) => candidate.id === next.modelId)
      const supported = model?.supportedReasoningEfforts
      if (supported !== undefined && next.effortLevel && !supported.includes(next.effortLevel)) {
        next.effortLevel = model?.defaultReasoningEffort ?? supported[0]
      }
      return next
    })
  }

  const applyPreset = (name: string) => {
    const preset = ROLE_PRESETS.find((p) => p.name === name)
    if (!preset) return
    setRole(preset.name)
    setDescription(preset.description)
  }

  const handleSupervisorChange = (checked: boolean) => {
    setSupervisor(checked)
    if (checked && !description.trim()) {
      setDescription(SUPERVISOR_DEFAULT_DESCRIPTION)
    }
  }

  const handleSubmit = async () => {
    setIsSubmitting(true)
    setError(null)
    try {
      const runtimeFields = {
        runtimeProviderId: runtime.providerId,
        runtimeModelId: runtime.modelId.trim() || undefined,
        effortLevel: selectedEffort,
      }
      if (mode === 'create') {
        // 协作会话要被主管无人值守地驱动：权限模式必须放行，
        // 否则员工会停在权限确认上无人批准，随后被空闲清理杀掉
        const newSessionId = await useSessionStore
          .getState()
          .createSession(workDir, { permissionMode: 'bypassPermissions' })
        if (serve || supervisor) {
          await setServant(newSessionId, {
            role: role.trim() || undefined,
            description: description.trim() || undefined,
            enabled: serve,
            supervisor,
            ...runtimeFields,
          })
        }
        const tabTitle = supervisor
          ? t('sidebar.supervisorBadge')
          : role.trim() || t('sidebar.newSession')
        useTabStore.getState().openTab(newSessionId, tabTitle)
        useChatStore.getState().connectToSession(newSessionId)
      } else if (sessionId) {
        await setServant(sessionId, {
          role: role.trim() || undefined,
          description: description.trim() || undefined,
          enabled: serve,
          supervisor,
          ...runtimeFields,
        })
      }
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const selectedPresetName = ROLE_PRESETS.find((p) => p.name === role)?.name ?? ''

  const providerOptions = providerChoices.map((choice: ProviderChoice) => ({
    value: choice.providerId ?? CLAUDE_OFFICIAL_OPTION_VALUE,
    label: choice.providerName,
  }))
  const modelOptions = (selectedChoice?.models ?? []).map((model) => ({
    value: model.id,
    label: model.name,
  }))
  const effortSelectOptions: Array<{ value: ReasoningEffortLevel; label: string }> =
    effortOptions.map((level) => ({
      value: level,
      label: t(`settings.general.effort.${level}`),
    }))

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={mode === 'create' ? t('servant.modal.createTitle') : t('servant.modal.editTitle')}
      footer={
        <div className="flex w-full items-center justify-end gap-2.5 border-t border-[var(--color-border)] pt-4">
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={handleSubmit} loading={isSubmitting}>
            {mode === 'create' ? t('servant.modal.create') : t('common.save')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <section className="flex flex-col gap-3">
          <SectionTitle>{t('servant.modal.sectionRole')}</SectionTitle>
          <div className="grid grid-cols-2 gap-3">
            <SelectField
              label={t('servant.modal.preset')}
              value={selectedPresetName}
              onChange={applyPreset}
              options={[
                { value: '', label: t('servant.modal.presetPlaceholder') },
                ...ROLE_PRESETS.map((p) => ({ value: p.name, label: p.name })),
              ]}
            />
            <Input
              label={t('servant.modal.role')}
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder={t('servant.modal.rolePlaceholder')}
            />
          </div>
          <TextArea
            label={t('servant.modal.description')}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('servant.modal.descriptionPlaceholder')}
            hint={t('servant.modal.descriptionHint')}
            rows={2}
          />
        </section>

        <section className="flex flex-col gap-3">
          <SectionTitle>{t('servant.modal.sectionIdentity')}</SectionTitle>
          <div className="grid grid-cols-2 gap-3">
            <Switch
              label={t('servant.modal.serve')}
              checked={serve}
              onChange={setServe}
            />
            <Switch
              label={t('servant.modal.supervisor')}
              checked={supervisor}
              onChange={handleSupervisorChange}
            />
          </div>
          <p className="text-[12px] leading-relaxed text-[var(--color-text-tertiary)] -mt-1">
            {t('servant.modal.identityHint')}
          </p>
        </section>

        <section className="flex flex-col gap-3">
          <SectionTitle>{t('servant.modal.sectionRuntime')}</SectionTitle>
          <div className="grid grid-cols-3 gap-3">
            <SelectField
              label={t('servant.modal.provider')}
              value={runtime.providerId ?? CLAUDE_OFFICIAL_OPTION_VALUE}
              onChange={(value) => updateRuntime({
                providerId: value === CLAUDE_OFFICIAL_OPTION_VALUE ? null : value,
              })}
              options={providerOptions}
            />
            <SelectField
              label={t('servant.modal.model')}
              value={runtime.modelId}
              onChange={(value) => updateRuntime({ modelId: value })}
              options={modelOptions}
            />
            <SelectField
              label={t('servant.modal.effort')}
              value={selectedEffort}
              onChange={(value) => updateRuntime({ effortLevel: value })}
              options={effortSelectOptions}
            />
          </div>
          <p className="text-[12px] leading-relaxed text-[var(--color-text-tertiary)]">
            {t('servant.modal.runtimeHint')}
          </p>
        </section>

        {error && (
          <span role="alert" className="text-[12.5px] text-[var(--color-error)]">
            {error}
          </span>
        )}
      </div>
    </Modal>
  )
}
