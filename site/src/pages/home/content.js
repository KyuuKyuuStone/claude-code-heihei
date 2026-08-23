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
      lede: '本地优先的桌面客户端：会话、改动、Agent、定时任务都摆在明处。接哪个模型你说了算，改哪一行你点头才算。',
      primary: '下载桌面端',
      secondary: '三步跑通第一条会话',
      badges: ['macOS · Windows · Linux', '开源免费', '数据留在本机'],
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
        ['到点自动跑', '重复流程设成定时任务，在独立会话里执行，每次都留记录。'],
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
          body: '标签页、项目切换、终端入口与会话历史集中管理，每个会话的状态一眼看清。',
          image: localizedImages.zh.shot1
        },
        {
          id: 'diff',
          label: '审阅',
          title: '逐文件 Diff 审阅',
          body: '列出本轮改动，任意文件一键打开带语法高亮的 Diff，看不顺眼可以撤销整轮。',
          image: localizedImages.zh.shot2
        },
        {
          id: 'models',
          label: '模型',
          title: '接入你自己的模型',
          body: '通过 API Key 添加服务商，DeepSeek、Kimi、智谱 GLM 等有现成预设，每条会话自由选择。',
          image: localizedImages.zh.shot3
        },
        {
          id: 'skills',
          label: '技能',
          title: '技能与定时任务',
          body: '把流程固化成技能随会话加载，重复工作设成定时任务，自动执行并留下记录。',
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
      lede: 'GitHub Releases 有三平台安装包；想从源码跑也就三行命令。',
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
      lede: 'A local-first desktop client. Sessions, diffs, agents and scheduled runs all sit in the open. You pick the model; nothing lands until you say so.',
      primary: 'Download the app',
      secondary: 'Run your first session',
      badges: ['macOS · Windows · Linux', 'Open source', 'Your data stays local'],
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
        ['Run on a clock', 'Turn routines into scheduled jobs that run in their own sessions and leave a record.'],
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
          body: 'Tabs, project switching, terminal entry and session history in one place, with every session’s state visible at a glance.',
          image: localizedImages.en.shot1
        },
        {
          id: 'diff',
          label: 'Review',
          title: 'File-by-file diff review',
          body: 'See this turn’s changes, open any file as a syntax-highlighted diff, and undo the whole turn if you don’t like it.',
          image: localizedImages.en.shot2
        },
        {
          id: 'models',
          label: 'Models',
          title: 'Bring your own model',
          body: 'Add providers via API key — presets for DeepSeek, Kimi, Zhipu GLM and more — and pick the model for each session.',
          image: localizedImages.en.shot3
        },
        {
          id: 'skills',
          label: 'Skills',
          title: 'Skills and scheduled tasks',
          body: 'Turn workflows into skills that load with sessions, and turn routines into scheduled jobs that run and leave a record.',
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
      lede: 'Installers for all three platforms on GitHub Releases — or three commands from source.',
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
