// v1.7.0 结构拆分第②批：SkillSettings 从 pages/Settings.tsx 逐字移出
// （原 1590-1613 行），逻辑零改动；门面 pages/Settings.tsx 保留为入口。

// ─── Skill Settings ──────────────────────────────────────

import { useSkillStore } from '../../stores/skillStore'
import { useTranslation } from '../../i18n'
import { SettingsPageHeader } from '@/components/settings/SettingsSection'
import { SkillList } from '../../components/skills/SkillList'
import { SkillDetail } from '../../components/skills/SkillDetail'

export function SkillSettings() {
  const selectedSkill = useSkillStore((s) => s.selectedSkill)
  const t = useTranslation()

  if (selectedSkill) {
    return (
      <div className="w-full min-w-0">
        <SkillDetail />
      </div>
    )
  }

  return (
    <div className="w-full min-w-0">
      <SettingsPageHeader
        title={t('settings.skills.title')}
        description={t('settings.skills.description')}
      />
      <SkillList />
    </div>
  )
}
