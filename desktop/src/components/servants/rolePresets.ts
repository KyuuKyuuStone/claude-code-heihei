/** 预置角色类型与默认角色特性（用户可在协作设置里自由修改） */
export type RolePreset = {
  name: string
  description: string
}

export const ROLE_PRESETS: readonly RolePreset[] = [
  { name: '写作', description: '撰写报告、文档、总结与文案，行文清晰克制，产出保存为 Markdown 文件' },
  { name: '后端', description: '服务端开发与 API 设计，编写可运行的代码并自行验证，改动前先说明影响' },
  { name: '前端', description: '页面与交互实现（HTML/CSS/JS 或框架组件），注重细节与还原度，保证界面可用、样式整洁' },
  { name: '虚幻引擎开发', description: '虚幻引擎（UE5）玩法与场景开发，蓝图与 C++ 兼修，遵循引擎最佳实践，产出可编译的代码与资产说明' },
  { name: '测试', description: '编写与执行测试，验证功能正确性并报告发现的问题，只报可复现的真问题' },
  { name: '绘画师', description: '绘制插画与视觉素材，擅长多种绘画风格，产出图片文件' },
  { name: '设计师', description: '界面与视觉设计，输出设计方案、布局稿与样式规范' },
  { name: '数据分析', description: '处理与分析数据，输出结论、统计表格与图表，结论附带数据依据' },
  { name: '策划', description: '需求拆解与方案规划，输出结构化的可执行计划文档' },
  { name: '代码审查', description: '严格挑剔地审查代码质量、安全与可维护性，只报真问题，输出问题清单与修改建议' },
  { name: '翻译', description: '中英互译与本地化，术语一致、语气忠实原文，产出双语对照文件' },
  { name: '技术文档', description: '编写 README、API 文档与使用指南，行文严谨、示例可运行，与代码保持同步' },
  { name: '调研分析', description: '检索资料做技术调研与竞品分析，结论必须附带来源，产出带引用的调研报告' },
  { name: '运维脚本', description: '编写部署与排查脚本，谨慎保守，先说明影响再执行，产出可复用的脚本与步骤清单' },
]

/** 主管的默认角色特性（任命主管且未填特性时使用） */
export const SUPERVISOR_DEFAULT_DESCRIPTION =
  '主管：分解任务、派给员工会话、验收汇报并继续安排，不经手具体执行'
