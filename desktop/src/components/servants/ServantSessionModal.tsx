import { useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Checkbox } from '@/components/ui/Checkbox'
import { SelectField } from '@/components/ui/SelectField'
import { Button } from '@/components/ui/Button'
import { useServantStore } from '../../stores/servantStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useChatStore } from '../../stores/chatStore'
import { useTabStore } from '../../stores/tabStore'
import { useTranslation } from '../../i18n'
import { ROLE_PRESETS, SUPERVISOR_DEFAULT_DESCRIPTION } from './rolePresets'

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

export function ServantSessionModal({ open, onClose, mode, sessionId, workDir }: Props) {
  const t = useTranslation()
  const { setServant } = useServantStore()
  const existing = useServantStore((s) =>
    sessionId ? s.bySessionId[sessionId] : undefined,
  )

  const [role, setRole] = useState(existing?.role || '')
  const [description, setDescription] = useState(existing?.description || '')
  const [serve, setServe] = useState(existing?.enabled ?? true)
  const [supervisor, setSupervisor] = useState(existing?.supervisor ?? false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
          })
        }
        useTabStore.getState().openTab(newSessionId, t('sidebar.newSession'))
        useChatStore.getState().connectToSession(newSessionId)
      } else if (sessionId) {
        await setServant(sessionId, {
          role: role.trim() || undefined,
          description: description.trim() || undefined,
          enabled: serve,
          supervisor,
        })
      }
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setIsSubmitting(false)
    }
  }

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
        <SelectField
          label={t('servant.modal.preset')}
          value=""
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
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="servant-role-description"
            className="text-[13px] font-medium text-[var(--color-text-primary)]"
          >
            {t('servant.modal.description')}
          </label>
          <textarea
            id="servant-role-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('servant.modal.descriptionPlaceholder')}
            rows={3}
            className="w-full resize-none rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[13.5px] leading-[1.5] text-[var(--color-text-primary)] outline-none transition-colors focus:border-[var(--color-border-focus)]"
          />
          <span className="text-[12px] text-[var(--color-text-tertiary)]">
            {t('servant.modal.descriptionHint')}
          </span>
        </div>
        <Checkbox
          label={t('servant.modal.serve')}
          description={t('servant.modal.serveHint')}
          checked={serve}
          onChange={(e) => setServe(e.target.checked)}
        />
        <Checkbox
          label={t('servant.modal.supervisor')}
          description={t('servant.modal.supervisorHint')}
          checked={supervisor}
          onChange={(e) => handleSupervisorChange(e.target.checked)}
        />
        {error && (
          <span role="alert" className="text-[12.5px] text-[var(--color-error)]">
            {error}
          </span>
        )}
      </div>
    </Modal>
  )
}
