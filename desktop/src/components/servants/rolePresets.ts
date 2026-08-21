/** 预置角色类型与默认角色特性（用户可在协作设置里自由修改） */
export type RolePreset = {
  name: string
  description: string
}

export const ROLE_PRESETS: readonly RolePreset[] = [
  { name: '写作', description: '撰写报告、文档、总结与文案，结构清晰，产出保存为 Markdown 文件' },
  { name: '后端', description: '服务端开发与 API 设计，编写可运行的代码并自行验证' },
  { name: '前端', description: '页面与交互实现（HTML/CSS/JS 或框架组件），保证界面可用、样式整洁' },
  { name: '测试', description: '编写与执行测试，验证功能正确性并报告发现的问题' },
  { name: '绘画师', description: '绘制插画与视觉素材，擅长多种绘画风格，产出图片文件' },
  { name: '设计师', description: '界面与视觉设计，输出设计方案、布局稿与样式规范' },
  { name: '数据分析', description: '处理与分析数据，输出结论、统计表格与图表' },
  { name: '策划', description: '需求拆解与方案规划，输出结构化的可执行计划文档' },
]

/** 主管的默认角色特性（任命主管且未填特性时使用） */
export const SUPERVISOR_DEFAULT_DESCRIPTION =
  '主管：分解任务、派给员工会话、验收汇报并继续安排，不经手具体执行'
