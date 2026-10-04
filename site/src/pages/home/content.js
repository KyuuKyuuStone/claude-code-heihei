import welcome from '../../../../docs/images/app/welcome.png'
import localModelHome from '../../../../docs/images/app/local-model-home.png'
import collabTasks from '../../../../docs/images/v1.7/collab-tasks.png'
import sidebar from '../../../../docs/images/v1.7/sidebar.png'

const localizedImages = {
  zh: { welcome, localModelHome, collabTasks, sidebar },
  en: { welcome, localModelHome, collabTasks, sidebar }
}

export const images = localizedImages.zh

export const content = {
  zh: {
    hero: {
      title: '主管派活，员工干活',
      lede: 'Windows 专属、自用为主的「主管/员工」AI 协作工作台：一个主管会话拆解派活，多个员工会话无人值守执行、完工自动汇报，全程可看可审计。',
      primary: '下载桌面端',
      secondary: '三步跑通第一条会话',
      badges: ['Windows', '开源免费', '数据留在本机'],
      image: welcome,
      imageAlt: '新建会话欢迎页：左侧是项目与会话列表，右侧是输入框、权限与模型选择（演示环境）',
      caption: '真实 App 的界面截图：项目、权限与模型一眼可见。'
    },
    capabilities: {
      title: '它替你做的事',
      lede: '不是一个聊天框，是一整套把「想法」变成「已合并」的工序。',
      items: [
        ['写代码', '说清目标，它读项目、拆任务、动手改，每一步的工具调用都能展开看。'],
        ['审改动', '改了哪些文件、每行怎么改，Diff 逐行摆出来；不点头就不落地。'],
        ['隔离试验', '把试验放进独立工作树，主分支一个字都不动。'],
        ['派 Agent', '大活拆给子 Agent 并行跑，进度和后台任务都汇总在活动面板。'],
        ['装技能', '技能市场里看中就装，来源和安全状态摆在明处。'],
        ['本地大模型（已冻结）', '不联网、不要 API Key，GGUF 模型直接跑在你自己的显卡上；该功能已冻结，不再新增功能，也不参与协作会话。'],
        ['操作电脑', 'Computer Use 让它看屏幕、点鼠标、敲键盘，敏感操作等你点头。'],
        ['上下级协作', '每项目任命主管、登记员工，自动派活、无人值守执行、完工汇报。']
      ]
    },
    localModel: {
      eyebrow: '本地大模型',
      title: '不联网、不要 API Key，跑在你自己的显卡上',
      lede: '内置 llama.cpp 内核，直接运行 GGUF 模型。识别你的硬件、推荐配置档位，一键跑分测出真实速度。',
      steps: [
        { image: localModelHome, title: '一目了然的本地模型首页', body: '硬件信息、配置方案、运行状态，一屏全摆出来。' }
      ],
      cta: { href: '/desktop/local-model', label: '看本地模型怎么用' }
    },
    tour: {
      title: '真实 App、真实任务，没有概念图',
      lede: '截图来自 Claude Code Heihei 桌面端，通过 API Key 接入 DeepSeek 等服务商，在真实项目中执行。',
      tabs: [
        {
          id: 'session',
          label: '会话',
          title: '多会话工作台',
          body: '标签页、项目切换与会话历史集中管理，每个会话的状态一眼看清。',
          image: localizedImages.zh.sidebar
        },
        {
          id: 'collab',
          label: '协作',
          title: '协作任务台账',
          body: '主管派活、员工无人值守执行与完工汇报，全部汇总进任务台账，按项目隔离。',
          image: localizedImages.zh.collabTasks
        }
      ]
    },
    paths: {
      title: '你是哪一种',
      lede: '文档只分两条路，别的都是这两条的支线。',
      items: [
        {
          eyebrow: '我想用起来',
          title: '从 0 到 1 把它跑起来',
          body: '装好应用、接上模型、跑通第一条会话，再一个个把功能用熟。不需要懂代码。',
          links: [
            ['/start/install', '下载与安装'],
            ['/start/models', '连接模型服务'],
            ['/start/first-session', '跑通第一条会话'],
            ['/desktop', '桌面端功能地图']
          ]
        },
        {
          eyebrow: '我想拆开看',
          title: '架构、实现与贡献',
          body: 'CLI 内核怎么分层、Agent 与 Skills 怎么调度、记忆怎么落盘、本地服务有哪些 API。',
          links: [
            ['/internals', '架构总览'],
            ['/internals/agent', '多 Agent 系统'],
            ['/internals/server', '本地 Server 与 API'],
            ['/internals/contributing', '参与贡献']
          ]
        }
      ]
    },
    install: {
      title: '装上试试',
      lede: 'GitHub Releases 提供 Windows 安装包；想从源码跑也就三行命令。',
      primary: '下载安装包',
      docs: '安装遇到问题',
      commandLabel: '从源码运行',
      copy: '复制',
      copied: '已复制'
    },
    footer: {
      tagline: '本地优先的 Claude Code 桌面客户端',
      columns: [
        ['文档', [['/start', '开始使用'], ['/desktop', '桌面端功能'], ['/cli', '命令行']]],
        ['开发者', [['/internals', '架构总览'], ['/internals/structure', '项目结构'], ['/internals/contributing', '参与贡献']]]
      ]
    }
  },

  en: {
    hero: {
      title: 'Supervisors dispatch, workers deliver',
      lede: 'A Windows-only, self-hosted supervisor–worker AI collaboration workspace: one supervisor session splits and dispatches work, worker sessions run unattended and report back.',
      primary: 'Download the app',
      secondary: 'Run your first session',
      badges: ['Windows', 'Open source', 'Your data stays local'],
      image: welcome,
      imageAlt: 'New-session welcome screen: project and session list on the left, composer with permission and model pickers on the right (demo environment)',
      caption: 'Real screenshots from the app: project, permissions and model visible up front.'
    },
    capabilities: {
      title: 'What it does for you',
      lede: 'Not a chat box — the whole path from an idea to a merged change.',
      items: [
        ['Write code', 'State the goal. It reads the project, splits the work, and edits — every tool call open for inspection.'],
        ['Review edits', 'Which files changed and exactly how, line by line. Nothing lands without your nod.'],
        ['Isolate experiments', 'Keep risky work in its own worktree and leave your main branch untouched.'],
        ['Delegate', 'Split big jobs across subagents; progress and background tasks roll up into one panel.'],
        ['Install skills', 'Browse the marketplace with source and safety status shown up front.'],
        ['Local models (frozen)', 'Offline, no API key — run GGUF models directly on your own GPU. This feature is frozen: no new development, and it does not take part in collaboration sessions.'],
        ['Drive the desktop', 'Computer Use can see the screen, click and type. Sensitive moves still wait for you.'],
        ['Supervisor–worker teams', 'Appoint a supervisor and register workers per project — auto-dispatch, unattended execution, and hand-off reports.']
      ]
    },
    localModel: {
      eyebrow: 'Local models',
      title: 'Offline, no API key — run on your own GPU',
      lede: 'The bundled llama.cpp runtime runs GGUF models directly. It detects your hardware, recommends a config tier, and benchmarks your real speed in one click.',
      steps: [
        { image: localModelHome, title: 'The local model page at a glance', body: 'Hardware, configurations, and run state all on one screen.' }
      ],
      cta: { href: '/en/desktop/local-model', label: 'See how local models work' }
    },
    tour: {
      title: 'Real app, real tasks, no concept art',
      lede: 'Screenshots from the Claude Code Heihei desktop app, connected to DeepSeek and other providers via API key, running in real projects.',
      tabs: [
        {
          id: 'session',
          label: 'Session',
          title: 'A multi-session workspace',
          body: 'Tabs, project switching and session history in one place, with every session’s state visible at a glance.',
          image: localizedImages.en.sidebar
        },
        {
          id: 'collab',
          label: 'Collab',
          title: 'Collaboration task ledger',
          body: 'Supervisor dispatch, unattended worker runs and hand-off reports all roll into one task ledger, scoped per project.',
          image: localizedImages.en.collabTasks
        }
      ]
    },
    paths: {
      title: 'Which one are you',
      lede: 'The docs run along two tracks. Everything else branches off them.',
      items: [
        {
          eyebrow: 'I want to use it',
          title: 'From zero to a working session',
          body: 'Install the app, connect a model, finish your first session, then learn the features one at a time. No code required.',
          links: [
            ['/en/start/install', 'Install'],
            ['/en/start/models', 'Connect a model'],
            ['/en/start/first-session', 'Your first session'],
            ['/en/desktop', 'Feature map']
          ]
        },
        {
          eyebrow: 'I want to read the source',
          title: 'Architecture, internals and contributing',
          body: 'How the CLI core is layered, how agents and skills are scheduled, how memory is persisted, what the local server exposes.',
          links: [
            ['/en/internals', 'Architecture overview'],
            ['/en/internals/agent', 'Multi-agent system'],
            ['/en/internals/server', 'Local server & API'],
            ['/en/internals/contributing', 'Contributing']
          ]
        }
      ]
    },
    install: {
      title: 'Try it',
      lede: 'Windows installer on GitHub Releases — or three commands from source.',
      primary: 'Download',
      docs: 'Install troubleshooting',
      commandLabel: 'Run from source',
      copy: 'Copy',
      copied: 'Copied'
    },
    footer: {
      tagline: 'A local-first desktop client for Claude Code',
      columns: [
        ['Docs', [['/en/start', 'Get started'], ['/en/desktop', 'Desktop app'], ['/en/cli', 'Command line']]],
        ['Developers', [['/en/internals', 'Architecture'], ['/en/internals/structure', 'Project structure'], ['/en/internals/contributing', 'Contributing']]]
      ]
    }
  }
}
