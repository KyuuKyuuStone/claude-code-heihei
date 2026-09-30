import { useEffect, useMemo, useRef, useState } from 'react'
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
import { buildProviderChoices, type ProviderChoice } from '../../lib/modelChoices'
import { resolveDefaultRuntimeSelection } from '../../lib/runtimeSelection'
import { useTranslation } from '../../i18n'
import type { TranslationKey } from '../../i18n/locales/en'
import { SUPERVISOR_DEFAULT_DESCRIPTION_KEY } from './rolePresets'
import {
  INDUSTRIES,
  FIRST_BATCH_SIZE,
  industryForRole,
  roleSummary,
  templateForRole,
  type IndustryId,
  type RoleTemplate,
} from './industryTemplates'
import type { ServantInput } from '../../api/servants'
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

type Identity = 'employee' | 'supervisor'

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
  const roster = useServantStore((s) => s.bySessionId)
  const existingSession = useSessionStore((s) =>
    sessionId ? s.sessions.find((session) => session.id === sessionId) : undefined,
  )
  const { providers, activeId, fetchProviders } = useProviderStore()
  const {
    currentModel: globalModelId,
    effortLevel: globalEffortLevel,
    activeProviderName,
  } = useSettingsStore()

  // edit 模式花名册尚未读到：不渲染空表单，避免用户误保存覆盖原身份（设计稿 2.2）
  const editingLoading = mode === 'edit' && !existing

  const [identity, setIdentity] = useState<Identity>(
    existing?.supervisor ? 'supervisor' : 'employee',
  )
  const [role, setRole] = useState(existing?.role || '')
  const [description, setDescription] = useState(existing?.description || '')
  const [serve, setServe] = useState(existing?.enabled ?? true)
  const [industry, setIndustry] = useState<IndustryId | undefined>(
    mode === 'edit' ? industryForRole(existing?.role) : undefined,
  )
  const [rolesExpanded, setRolesExpanded] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  // 用户手动改过角色名/职责（模板选择不算）：异步回填与切行业只在这些为 false 时生效
  const [roleEdited, setRoleEdited] = useState(false)
  const [descEdited, setDescEdited] = useState(false)
  const [constraint, setConstraint] = useState<'readonly' | 'whitelist' | undefined>(
    existing?.constraint === 'whitelist' ? 'whitelist' : existing?.constraint === 'readonly' ? 'readonly' : undefined,
  )
  const [writeDirsText, setWriteDirsText] = useState(existing?.writeDirs?.join('\n') ?? '')
  const [writeDirsTouched, setWriteDirsTouched] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 创建成功但登记失败：保存已建会话 id，重试只做登记，绝不重复创建（设计稿第 7 节）
  const [createdSessionId, setCreatedSessionId] = useState<string | null>(null)

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

  // writeDirs 预填守卫（坑③：异步 store 数据到达不得覆盖用户输入）：
  // 已手动编辑 → 以用户为准；edit 已有持久化值 → 以持久化值为准；
  // 否则档位切到 whitelist 且输入为空时，才回填会话工作目录作为默认白名单
  const hasPersistedWriteDirs = mode === 'edit' && Boolean(existing?.writeDirs?.length)
  const defaultWriteDir = mode === 'create' ? workDir : existingSession?.workDir
  useEffect(() => {
    if (writeDirsTouched) return
    if (hasPersistedWriteDirs && existing?.writeDirs?.length) {
      setWriteDirsText(existing.writeDirs.join('\n'))
      return
    }
    if (constraint === 'whitelist' && defaultWriteDir) {
      setWriteDirsText((prev) => (prev.trim() === '' ? defaultWriteDir : prev))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [constraint, writeDirsTouched, hasPersistedWriteDirs, existing?.writeDirs, defaultWriteDir])

  // 异步回填守卫（设计稿 2.2）：仅在「打开弹窗 + 目标会话变化 + 用户未手改」时
  // 刷新草稿。用 ref 记录已初始化的会话，避免花名册刷新（新对象）把用户在弹窗内
  // 已切换的身份/字段重置回存档值。
  const initializedSessionRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!open) {
      initializedSessionRef.current = undefined
      return
    }
    if (mode !== 'edit' || !existing) return
    if (initializedSessionRef.current === existing.sessionId) return
    if (roleEdited || descEdited) return
    initializedSessionRef.current = existing.sessionId
    setRole(existing.role || '')
    setDescription(existing.description || '')
    setIndustry(industryForRole(existing.role))
    setIdentity(existing.supervisor ? 'supervisor' : 'employee')
    setServe(existing.enabled ?? true)
    setConstraint(
      existing.constraint === 'whitelist' ? 'whitelist' : existing.constraint === 'readonly' ? 'readonly' : undefined,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, existing?.sessionId, roleEdited, descEdited])

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
    () => buildProviderChoices(providers, activeId, roleLabels),
    [activeId, providers, roleLabels],
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

  const roleNameOf = (template: RoleTemplate) =>
    t(`servant.presets.${template.key}.name` as TranslationKey)
  const roleDescOf = (template: RoleTemplate) =>
    t(`servant.presets.${template.key}.description` as TranslationKey)

  const selectedIndustry = useMemo(
    () => INDUSTRIES.find((entry) => entry.id === industry) ?? null,
    [industry],
  )
  const selectedTemplate = templateForRole(role)
  const roles = selectedIndustry?.roles ?? []
  const visibleRoles = rolesExpanded ? roles : roles.slice(0, FIRST_BATCH_SIZE)
  const hiddenRoleCount = Math.max(0, roles.length - FIRST_BATCH_SIZE)

  const changeIdentity = (next: Identity) => {
    setIdentity(next)
    if (next === 'supervisor' && !descEdited && !description.trim()) {
      setDescription(t(SUPERVISOR_DEFAULT_DESCRIPTION_KEY))
    }
  }

  const changeIndustry = (value: string) => {
    const next = (value || undefined) as IndustryId | undefined
    setIndustry(next)
    setRolesExpanded(false)
    // 未手改过时清掉上一条模板填充，等待用户重新选择（设计稿 2.2 切行业）
    if (!roleEdited) setRole('')
    if (!descEdited) setDescription('')
  }

  const selectTemplate = (template: RoleTemplate) => {
    setRole(template.name)
    // 保留用户已写的职责，仅替换角色名（设计稿一期就地提示策略）
    if (!descEdited) setDescription(roleDescOf(template))
  }

  const startCustomRole = () => {
    setRole('')
    setDescription('')
    setRoleEdited(false)
    setDescEdited(false)
  }

  const parsedWriteDirs = writeDirsText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  const targetWorkDir = mode === 'create' ? workDir : (existingSession?.workDir ?? existing?.workDir)
  // 同工作目录已有主管：提前可见并禁用任命，不代替用户撤销原主管（设计稿 2.1.4）
  const supervisorConflict = useMemo(() => {
    if (!targetWorkDir) return null
    return (
      Object.values(roster).find(
        (entry) =>
          entry.supervisor &&
          entry.sessionId !== sessionId &&
          entry.workDir === targetWorkDir,
      ) ?? null
    )
  }, [roster, sessionId, targetWorkDir])

  const roleRequired = mode === 'create' && identity === 'employee' && !role.trim()
  const writeDirsInvalid = constraint === 'whitelist' && parsedWriteDirs.length === 0
  const canSubmit = !editingLoading && !isSubmitting && !roleRequired && !writeDirsInvalid

  const handleSubmit = async () => {
    if (!canSubmit) return
    setIsSubmitting(true)
    setError(null)
    try {
      const runtimeFields = {
        runtimeProviderId: runtime.providerId,
        runtimeModelId: runtime.modelId.trim() || undefined,
        effortLevel: selectedEffort,
      }
      const isSupervisor = identity === 'supervisor'
      const baseInput: ServantInput = {
        role: role.trim() || undefined,
        description: description.trim() || undefined,
        enabled: serve,
        supervisor: isSupervisor,
        ...runtimeFields,
      }

      if (mode === 'create') {
        // 协作会话要被主管无人值守地驱动：权限模式必须放行
        let targetId = createdSessionId
        if (!targetId) {
          targetId = await useSessionStore
            .getState()
            .createSession(workDir, { permissionMode: 'bypassPermissions' })
          setCreatedSessionId(targetId)
        }
        await setServant(targetId, {
          ...baseInput,
          ...(constraint ? { constraint } : {}),
          ...(constraint === 'whitelist' ? { writeDirs: parsedWriteDirs } : {}),
        })
        const tabTitle = isSupervisor
          ? t('sidebar.supervisorBadge')
          : role.trim() || t('sidebar.newSession')
        useTabStore.getState().openTab(targetId, tabTitle)
        useChatStore.getState().connectToSession(targetId)
      } else if (sessionId) {
        // 约束三态：显式值→设档；原本受限、现切回完全执行→发 null 清除；从未受限→不传
        const constraintValue: ServantInput['constraint'] =
          constraint ?? (existing?.constraint ? null : undefined)
        await setServant(sessionId, {
          ...baseInput,
          ...(constraintValue !== undefined ? { constraint: constraintValue } : {}),
          ...(constraint === 'whitelist' ? { writeDirs: parsedWriteDirs } : {}),
        })
      }
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setIsSubmitting(false)
    }
  }

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

  const permissionShort = constraint === 'readonly'
    ? t('servant.modal.constraintShortReadonly')
    : constraint === 'whitelist'
      ? t('servant.modal.constraintShortWhitelist')
      : t('servant.modal.constraintShortFull')
  const advancedSummary =
    `${permissionShort} · ${selectedModel?.name ?? '—'} · ${t(`settings.general.effort.${selectedEffort}`)}`

  const submitLabel = mode === 'create'
    ? (createdSessionId ? t('common.retry') : t('servant.modal.createCollab'))
    : t('servant.modal.saveSettings')

  const identityButtonClass = (active: boolean) =>
    [
      'flex flex-col items-start gap-0.5 rounded-[var(--radius-md)] border px-3 py-2 text-left transition-colors',
      active
        ? 'border-[var(--color-brand)] bg-[var(--color-brand-soft)]'
        : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)]',
      'disabled:cursor-not-allowed disabled:opacity-50',
    ].join(' ')

  return (
    <Modal
      open={open}
      onClose={isSubmitting ? () => {} : onClose}
      title={mode === 'create' ? t('servant.modal.createTitle') : t('servant.modal.editTitle')}
      footer={
        <div className="flex w-full items-center justify-end gap-2.5 border-t border-[var(--color-border)] pt-4">
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSubmit} loading={isSubmitting} disabled={!canSubmit}>
            {submitLabel}
          </Button>
        </div>
      }
    >
      {editingLoading ? (
        <p className="py-8 text-center text-[13px] text-[var(--color-text-tertiary)]">
          {t('servant.modal.loadingExisting')}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {/* ── 身份 ───────────────────────────────────────────── */}
          <section className="flex flex-col gap-3">
            <SectionTitle>{t('servant.modal.identity')}</SectionTitle>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                aria-label={t('servant.modal.identityEmployee')}
                aria-pressed={identity === 'employee'}
                className={identityButtonClass(identity === 'employee')}
                onClick={() => changeIdentity('employee')}
              >
                <span className="text-[13px] font-medium text-[var(--color-text-primary)]">
                  {t('servant.modal.identityEmployee')}
                </span>
                <span className="text-[11.5px] text-[var(--color-text-tertiary)]">
                  {t('servant.modal.identityEmployeeHint')}
                </span>
              </button>
              <button
                type="button"
                aria-label={t('servant.modal.identitySupervisor')}
                aria-pressed={identity === 'supervisor'}
                className={identityButtonClass(identity === 'supervisor')}
                onClick={() => changeIdentity('supervisor')}
                disabled={Boolean(supervisorConflict)}
              >
                <span className="text-[13px] font-medium text-[var(--color-text-primary)]">
                  {t('servant.modal.identitySupervisor')}
                </span>
                <span className="text-[11.5px] text-[var(--color-text-tertiary)]">
                  {t('servant.modal.identitySupervisorHint')}
                </span>
              </button>
            </div>
            {identity === 'supervisor' && (
              <p className="text-[12px] leading-relaxed text-[var(--color-text-tertiary)]">
                {t('servant.modal.supervisorDutyHint')}
              </p>
            )}
            {supervisorConflict && (
              <p role="alert" className="text-[12.5px] text-[var(--color-error)]">
                {t('servant.modal.supervisorConflict')}
              </p>
            )}
            {identity === 'employee' && mode === 'edit' && (
              <>
                <Switch
                  label={t('servant.modal.serveToggle')}
                  checked={serve}
                  onChange={setServe}
                />
                <p className="text-[12px] leading-relaxed text-[var(--color-text-tertiary)] -mt-1">
                  {t('servant.modal.serveToggleHint')}
                </p>
              </>
            )}
          </section>

          {/* ── 行业 + 角色 ────────────────────────────────────── */}
          <section className="flex flex-col gap-3">
            <SectionTitle>{t('servant.modal.sectionRole')}</SectionTitle>
            <SelectField
              label={t('servant.modal.industry')}
              value={industry ?? ''}
              onChange={changeIndustry}
              options={[
                { value: '', label: t('servant.modal.industryPlaceholder') },
                ...INDUSTRIES.map((entry) => ({
                  value: entry.id,
                  label: t(entry.titleKey as TranslationKey),
                })),
              ]}
            />
            {identity === 'employee' && (
              <>
                {!selectedIndustry ? (
                  <p className="text-[12px] text-[var(--color-text-tertiary)]">
                    {t('servant.modal.rolePickEmpty')}
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    <span className="text-[12px] text-[var(--color-text-secondary)]">
                      {t('servant.modal.rolePick')}
                      <span className="text-[var(--color-text-tertiary)]">
                        {' · '}
                        {t('servant.modal.rolePickHint')}
                      </span>
                    </span>
                    <div className="grid grid-cols-2 gap-2">
                      {visibleRoles.map((template) => {
                        const selected = selectedTemplate?.key === template.key
                        return (
                          <button
                            key={template.key}
                            type="button"
                            aria-pressed={selected}
                            className={[
                              'flex flex-col gap-0.5 rounded-[var(--radius-md)] border px-3 py-2 text-left transition-colors',
                              selected
                                ? 'border-[var(--color-brand)] bg-[var(--color-brand-soft)]'
                                : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)]',
                            ].join(' ')}
                            onClick={() => selectTemplate(template)}
                          >
                            <span className="text-[13px] font-medium text-[var(--color-text-primary)]">
                              {roleNameOf(template)}
                            </span>
                            <span className="line-clamp-2 text-[11.5px] leading-snug text-[var(--color-text-tertiary)]">
                              {roleSummary(roleDescOf(template))}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                    {hiddenRoleCount > 0 && (
                      <div>
                        <Button
                          variant="link"
                          size="sm"
                          onClick={() => setRolesExpanded((value) => !value)}
                        >
                          {rolesExpanded
                            ? t('servant.modal.rolesLess')
                            : t('servant.modal.rolesMore', { count: hiddenRoleCount })}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
                <div className="flex">
                  <Button variant="ghost" size="sm" onClick={startCustomRole}>
                    {t('servant.modal.customRole')}
                  </Button>
                </div>
              </>
            )}
            <Input
              label={t('servant.modal.roleName')}
              value={role}
              onChange={(e) => {
                setRoleEdited(true)
                setRole(e.target.value)
              }}
              placeholder={t('servant.modal.rolePlaceholder')}
            />
            <TextArea
              label={t('servant.modal.responsibility')}
              value={description}
              onChange={(e) => {
                setDescEdited(true)
                setDescription(e.target.value)
              }}
              placeholder={t('servant.modal.descriptionPlaceholder')}
              hint={t('servant.modal.descriptionHint')}
              rows={7}
            />
            {roleRequired && (
              <p role="alert" className="text-[12.5px] text-[var(--color-error)]">
                {t('servant.modal.roleRequired')}
              </p>
            )}
          </section>

          {/* ── 高级选项（默认收起，单层折叠） ──────────────────── */}
          <section className="flex flex-col gap-3">
            <button
              type="button"
              aria-expanded={advancedOpen}
              className="flex w-full items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2 text-left"
              onClick={() => setAdvancedOpen((value) => !value)}
            >
              <span className="flex items-center gap-2 text-[12.5px] font-medium text-[var(--color-text-secondary)]">
                <span aria-hidden="true">{advancedOpen ? '▾' : '▸'}</span>
                {t('servant.modal.advanced')}
              </span>
              <span className="text-[12px] text-[var(--color-text-tertiary)]">{advancedSummary}</span>
            </button>
            {advancedOpen && (
              <div className="flex flex-col gap-3">
                <SelectField
                  label={t('servant.modal.constraint')}
                  value={constraint ?? ''}
                  onChange={(value) =>
                    setConstraint(value === 'readonly' || value === 'whitelist' ? value : undefined)
                  }
                  options={[
                    { value: '', label: t('servant.modal.constraintFull') },
                    { value: 'readonly', label: t('servant.modal.constraintReadonly') },
                    { value: 'whitelist', label: t('servant.modal.constraintWhitelist') },
                  ]}
                />
                {constraint === 'whitelist' && (
                  <TextArea
                    label={t('servant.modal.writeDirs')}
                    value={writeDirsText}
                    onChange={(e) => {
                      setWriteDirsTouched(true)
                      setWriteDirsText(e.target.value)
                    }}
                    placeholder={t('servant.modal.writeDirsPlaceholder')}
                    hint={t('servant.modal.writeDirsHint')}
                    rows={3}
                  />
                )}
                {writeDirsInvalid && (
                  <p role="alert" className="text-[12.5px] text-[var(--color-error)]">
                    {t('servant.modal.writeDirsRequired')}
                  </p>
                )}
                <p className="text-[12px] leading-relaxed text-[var(--color-text-tertiary)]">
                  {t('servant.modal.constraintScopeHint')}
                </p>
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
              </div>
            )}
          </section>

          <p className="text-[12px] leading-relaxed text-[var(--color-text-tertiary)]">
            {identity === 'supervisor'
              ? t('servant.modal.createNoteSupervisor')
              : t('servant.modal.createNote')}
          </p>

          {createdSessionId && (
            <p role="alert" className="text-[12.5px] text-[var(--color-error)]">
              {t('servant.modal.partialFailure')}
            </p>
          )}
          {error && (
            <p role="alert" className="text-[12.5px] text-[var(--color-error)]">
              {error}
            </p>
          )}
        </div>
      )}
    </Modal>
  )
}
