import { useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { TextArea } from '@/components/ui/TextArea'
import { Button } from '@/components/ui/Button'
import { servantsApi } from '../../api/servants'
import { useTranslation } from '../../i18n'

type Props = {
  open: boolean
  /** 主管会话 ID（广播发起者，自动从目标中排除） */
  supervisorSessionId: string
  onClose: () => void
}

export function BroadcastDialog({ open, supervisorSessionId, onClose }: Props) {
  const t = useTranslation()
  const [content, setContent] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSend = async () => {
    if (!content.trim()) return
    setIsSending(true)
    setError(null)
    try {
      await servantsApi.broadcast(content.trim(), supervisorSessionId)
      onClose()
      setContent('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsSending(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('servant.broadcast.title')}
      footer={
        <div className="flex w-full items-center justify-end gap-2.5 border-t border-[var(--color-border)] pt-4">
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={handleSend} loading={isSending}>{t('common.send')}</Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <TextArea
          label={t('servant.broadcast.content')}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={t('servant.broadcast.placeholder')}
          rows={4}
          hint={t('servant.broadcast.hint')}
        />
        {error && (
          <span role="alert" className="text-[12.5px] text-[var(--color-error)]">{error}</span>
        )}
      </div>
    </Modal>
  )
}
