// v1.7.0 结构拆分第②批：PluginSettings 从 pages/Settings.tsx 逐字移出
// （原 1615-1636 行），逻辑零改动；门面 pages/Settings.tsx 保留为入口。

import { usePluginStore } from '../../stores/pluginStore'
import { useTranslation } from '../../i18n'
import { SettingsPageHeader } from '@/components/settings/SettingsSection'
import { PluginList } from '../../components/plugins/PluginList'
import { PluginDetail } from '../../components/plugins/PluginDetail'

export function PluginSettings() {
  const selectedPlugin = usePluginStore((s) => s.selectedPlugin)
  const t = useTranslation()

  if (selectedPlugin) {
    return (
      <div className="w-full min-w-0">
        <PluginDetail />
      </div>
    )
  }

  return (
    <div className="w-full min-w-0">
      <SettingsPageHeader
        title={t('settings.plugins.title')}
        description={t('settings.plugins.description')}
      />
      <PluginList />
    </div>
  )
}
