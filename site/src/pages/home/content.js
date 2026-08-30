import shot1 from '../../../../docs/images/app/ZY01.jpg'
import shot2 from '../../../../docs/images/app/ZY02.jpg'
import shot3 from '../../../../docs/images/app/ZY03.jpg'
import shot4 from '../../../../docs/images/app/ZY04.jpg'

const localizedImages = {
  zh: { shot1, shot2, shot3, shot4 },
  en: { shot1, shot2, shot3, shot4 }
}

export const images = localizedImages.zh

export const content = {
  zh: {
    hero: {
      title: '让 Claude Code 有个能看见的地方干活',
      lede: '本地优先的桌面客户端：会话、改动、Agent 都摆在明处。接哪个模型你说了算，改哪一行你点头才算。',
      primary: '下载桌面端',
      secondary: '三步跑通第一条会话',
      badges: ['Windows', '开源免费', '数据留在本机'],
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
        ['本地大模型', '不联网、不要 API Key，GGUF 模型直接跑在你自己的显卡上。'],
        ['操作电脑', 'Computer Use 让它看屏幕、点鼠标、敲键盘，敏感操作等你点头。'],
        ['上下级协作', '每项目任命主管、登记员工，自动派活、无人值守执行、完工汇报。']
      ]
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
          image: localizedImages.zh.shot1
        },
        {
          id: 'collab',
          label: '协作',
          title: '右键协作设置',
          body: '在会话上点右键，把任意会话登记为员工、任命主管，按项目组建团队。',
          image: localizedImages.zh.shot2
        },
        {
          id: 'collab-dialog',
          label: '配置',
          title: '协作设置弹窗',
          body: '设定角色与特性，主管向员工派活，员工无人值守执行、完工自动汇报。',
          image: localizedImages.zh.shot3
        },
        {
          id: 'workers',
          label: '员工',
          title: '协作会话与员工标识',
          body: '会话列表里一眼分清主管与员工身份，派活与汇报按项目隔离。',
          image: localizedImages.zh.shot4
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
      title: 'Give Claude Code somewhere you can watch it work',
      lede: 'A local-first desktop client. Sessions, diffs and agents all sit in the open. You pick the model; nothing lands until you say so.',
      primary: 'Download the app',
      secondary: 'Run your first session',
      badges: ['Windows', 'Open source', 'Your data stays local'],
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
        ['Local models', 'Offline, no API key — run GGUF models directly on your own GPU.'],
        ['Drive the desktop', 'Computer Use can see the screen, click and type. Sensitive moves still wait for you.'],
        ['Supervisor–worker teams', 'Appoint a supervisor and register workers per project — auto-dispatch, unattended execution, and hand-off reports.']
      ]
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
          image: localizedImages.en.shot1
        },
        {
          id: 'collab',
          label: 'Collab',
          title: 'Right-click collaboration setup',
          body: 'Right-click a session to register it as a worker or appoint a supervisor, building a team per project.',
          image: localizedImages.en.shot2
        },
        {
          id: 'collab-dialog',
          label: 'Config',
          title: 'Collaboration setup dialog',
          body: 'Set roles and traits — the supervisor dispatches tasks, workers run unattended and report back.',
          image: localizedImages.en.shot3
        },
        {
          id: 'workers',
          label: 'Workers',
          title: 'Collaboration sessions and worker badges',
          body: 'See supervisor and worker roles at a glance in the session list, with dispatch scoped per project.',
          image: localizedImages.en.shot4
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
