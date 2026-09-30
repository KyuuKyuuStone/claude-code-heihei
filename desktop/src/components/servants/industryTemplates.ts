/**
 * 行业 → 角色模板（协作设置弹窗重设计，设计稿第 3 节）。
 *
 * 稳定值约定：
 * - `name` 是写入协作身份（持久化）的稳定中文正名，跨语言不变。既有 14 个
 *   角色（ROLE_PRESETS）的 name 绝不允许改名，否则旧存档无法按 name 反推行业。
 * - `key` 是 i18n 后缀，展示名与默认职责走 `servant.presets.<key>.name` /
 *   `.description`；旧角色沿用 rolePresets.ts 的原 key，新增角色补齐五语言。
 * - 同一个 name 在整个表内唯一，才能保证「按 name 反推行业」无歧义。
 *
 * 行业仅用于前端筛选，不发送到服务端、不新增后端字段（设计稿第 6 节）。
 */

export type IndustryId = 'software' | 'fiction' | 'content' | 'data' | 'research' | 'custom'

export type RoleTemplate = {
  /** i18n 后缀，跨行业唯一 */
  key: string
  /** 持久化中文 role（稳定值，跨语言不变） */
  name: string
}

export type IndustryTemplate = {
  id: IndustryId
  /** 行业标题 i18n key */
  titleKey: `servant.industry.${IndustryId}`
  roles: readonly RoleTemplate[]
}

/** 各行业首批展示的角色数（超出部分点「查看其他角色」展开，不新开二级弹窗）。 */
export const FIRST_BATCH_SIZE = 4

export const INDUSTRIES: readonly IndustryTemplate[] = [
  {
    id: 'software',
    titleKey: 'servant.industry.software',
    roles: [
      { key: 'backend', name: '后端' },
      { key: 'frontend', name: '前端' },
      { key: 'tester', name: '测试' },
      { key: 'reviewer', name: '代码审查' },
      { key: 'designer', name: '设计师' },
      { key: 'tech-writer', name: '技术文档' },
      { key: 'ops-scripter', name: '运维脚本' },
      { key: 'ue-developer', name: '虚幻引擎开发' },
      // 架构师只在方案设计/裁决/发布把关/架构守护四节点介入，非日常执行，
      // 故排在软件开发首批 4 个之外（点「查看其他角色」可见）。
      { key: 'architect', name: '架构师' },
    ],
  },
  {
    id: 'fiction',
    titleKey: 'servant.industry.fiction',
    roles: [
      { key: 'writer', name: '写作' },
      { key: 'story-planner', name: '故事策划' },
      { key: 'setting-editor', name: '设定编辑' },
      { key: 'copy-editor', name: '文字编辑' },
      { key: 'illustrator', name: '绘画师' },
      { key: 'translator', name: '翻译' },
    ],
  },
  {
    id: 'content',
    titleKey: 'servant.industry.content',
    roles: [
      { key: 'topic-planner', name: '选题策划' },
      { key: 'content-writer', name: '内容撰稿' },
      { key: 'short-video-script', name: '短视频脚本' },
      { key: 'content-editor', name: '内容编辑' },
      { key: 'ops-review', name: '运营复盘' },
    ],
  },
  {
    id: 'data',
    titleKey: 'servant.industry.data',
    roles: [
      { key: 'data-analyst', name: '数据分析' },
      { key: 'metric-designer', name: '指标设计' },
      { key: 'data-cleaner', name: '数据清洗' },
      { key: 'viz-designer', name: '可视化设计' },
      { key: 'analysis-reviewer', name: '分析审查' },
    ],
  },
  {
    id: 'research',
    titleKey: 'servant.industry.research',
    roles: [
      { key: 'researcher', name: '调研分析' },
      { key: 'literature-review', name: '文献综述' },
      { key: 'method-designer', name: '方法设计' },
      { key: 'paper-writer', name: '论文写作' },
      { key: 'academic-reviewer', name: '学术审阅' },
    ],
  },
  {
    id: 'custom',
    titleKey: 'servant.industry.custom',
    roles: [
      { key: 'planner', name: '策划' },
      { key: 'material-organizer', name: '资料整理' },
      { key: 'proposal-writer', name: '方案撰写' },
      { key: 'quality-inspector', name: '质量检查' },
      { key: 'collab-coordinator', name: '协作协调' },
    ],
  },
]

/** name → 所属行业（按唯一 name 建索引）。 */
const ROLE_INDUSTRY = new Map<string, IndustryId>(
  INDUSTRIES.flatMap((industry) =>
    industry.roles.map((role) => [role.name, industry.id] as const),
  ),
)

/** name → 模板（用于按 role 精确回显到对应行业的角色卡片）。 */
const ROLE_BY_NAME = new Map<string, RoleTemplate>(
  INDUSTRIES.flatMap((industry) => industry.roles.map((role) => [role.name, role] as const)),
)

/**
 * 按持久化 role 反推行业。未命中任何模板（含旧用户手写角色）返回 `custom`，
 * 交由弹窗显示「通用自定义 / 自定义角色」并保留原文，绝不按普通自定义覆盖存档。
 */
export function industryForRole(role: string | undefined): IndustryId {
  if (!role) return 'custom'
  return ROLE_INDUSTRY.get(role) ?? 'custom'
}

/** 按持久化 role 命中模板（未命中返回 undefined）。 */
export function templateForRole(role: string | undefined): RoleTemplate | undefined {
  if (!role) return undefined
  return ROLE_BY_NAME.get(role)
}

/**
 * 从角色默认文案中抽出「负责」段的首句，用于角色卡片摘要。
 *
 * 默认文案统一为四段格式：「负责：…\n不负责：…\n交付：…\n汇报：…」。卡片
 * 只展示第一段的首句，完整文案进可编辑的职责输入框。实现按「冒号后的首个句末
 * 标点」截断，语言无关（zh/zh-TW 用全角标点，en 等用半角）。
 */
export function roleSummary(description: string): string {
  const firstLine = description.split('\n', 1)[0] ?? ''
  const colon = firstLine.search(/[:：]/)
  const body = (colon >= 0 ? firstLine.slice(colon + 1) : firstLine).trim()
  const match = body.match(/^[^。．.；;!?！？]*[。．.；;!?！？]?/)
  return (match?.[0] ?? body).replace(/[。．.；;!?！？\s]+$/, '').trim() || body
}
