/**
 * 预置角色类型（用户可在协作设置里自由修改）。
 * name 是稳定标识：作为选择值与写入协作身份的角色名，须与既有存档匹配；
 * 展示名与默认特性文案走 i18n（servant.presets.<key>.name / .description）。
 */
export type RolePreset = {
  /** i18n key 后缀 */
  key: string
  /** 稳定角色标识（中文正名，跨语言不变） */
  name: string
}

export const ROLE_PRESETS: readonly RolePreset[] = [
  { key: 'writer', name: '写作' },
  { key: 'backend', name: '后端' },
  { key: 'frontend', name: '前端' },
  { key: 'ue-developer', name: '虚幻引擎开发' },
  { key: 'tester', name: '测试' },
  { key: 'illustrator', name: '绘画师' },
  { key: 'designer', name: '设计师' },
  { key: 'data-analyst', name: '数据分析' },
  { key: 'planner', name: '策划' },
  { key: 'reviewer', name: '代码审查' },
  { key: 'translator', name: '翻译' },
  { key: 'tech-writer', name: '技术文档' },
  { key: 'researcher', name: '调研分析' },
  { key: 'ops-scripter', name: '运维脚本' },
]

/** 主管默认角色特性的 i18n key（任命主管且未填特性时预填） */
export const SUPERVISOR_DEFAULT_DESCRIPTION_KEY = 'servant.presets.supervisor.description'
