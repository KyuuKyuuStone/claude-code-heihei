// v1.7.0 结构拆分第①批（providers）：从 pages/Settings.tsx 逐字移出的
// 跨区共享 UI 常量/组件（ProviderFormModal 与门面留守的 GeneralSettings
// 双方都在使用，为避免门面↔子模块循环依赖，落在中立模块）。

export const SETTINGS_CHECKBOX_INPUT_CLASS = 'settings-checkbox-input peer'

export function SettingsCheckboxMark({ checked, disabled = false }: { checked: boolean; disabled?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-md)] border transition-all peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--color-border-focus)] ${
        checked
          ? 'border-[var(--color-brand)] bg-[var(--color-brand)] text-[var(--color-on-primary)] shadow-[var(--shadow-button-primary)]'
          : 'border-[var(--color-border-focus)] bg-[var(--color-surface)] text-transparent'
      } ${disabled ? 'opacity-50' : ''}`}
    >
      <span className="material-symbols-outlined text-[16px] leading-none" style={{ fontVariationSettings: "'FILL' 1" }}>
        check
      </span>
    </span>
  )
}
