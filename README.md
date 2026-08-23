# Claude Code Heihei

<p align="center">
  <img src="docs/images/logo-horizontal.png" alt="Claude Code Heihei" width="480">
</p>

<div align="center">

[![License](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

**English** · [简体中文](README.zh-CN.md)

</div>

Claude Code Heihei is a **desktop Claude Code workspace** for macOS, Windows, and Linux. It adds a **session-level supervisor–worker collaboration** layer on top of the classic session workspace, while keeping multi-session, multi-project, diff review, permission approval, model setup, Computer Use, skill marketplace, and scheduled tasks in one app.

## Download

[![Download Windows installer](https://img.shields.io/badge/⬇%20Download-Windows%20exe-FF7A00?style=for-the-badge)](https://github.com/KyuuKyuuStone/claude-code-heihei/releases/latest/download/Claude-Code-Heihei-1.0.0-win-x64.exe)

> For other platforms and versions, see [Releases](https://github.com/KyuuKyuuStone/claude-code-heihei/releases).

## Screenshots

|  |  |
|:--:|:--:|
| ![Screenshot 1](docs/images/app/ZY01.jpg) | ![Screenshot 2](docs/images/app/ZY02.jpg) |
| ![Screenshot 3](docs/images/app/ZY03.jpg) | ![Screenshot 4](docs/images/app/ZY04.jpg) |

## Features

### Supervisor–worker collaboration (new in this project)

- **Supervisor / workers**: appoint one supervisor per project and register any session as a worker, with free-form roles and traits (backend / frontend / writing / painter …).
- **Automatic dispatch**: the supervisor dispatches tasks to worker sessions, which run unattended (permissions auto-approved) and report back when done.
- **Review & deliver**: the supervisor reviews each report, then keeps going or delivers to the user.
- **Project isolation**: roster and dispatch are scoped by working directory — cross-project dispatch is rejected by the server.

### Session workspace

- **Multi-session**: tabs, project switching, terminal entry, and session history in one place.
- **Branch / Worktree**: start a session on any branch, using the current working tree or an isolated Worktree.
- **File-by-file diff review**: see this turn's changes, open any file as a syntax-highlighted diff, and undo the whole turn.

### AI capabilities

- **Multi-agent**: SubAgents / Agent Teams — subagents share context and collaborate.
- **Skill marketplace**: discover, preview, and install third-party skills from ClawHub / SkillHub, with source and safety status up front.
- **Skills system**: turn workflows into skills that load automatically with sessions.
- **Memory system**: automatic memory plus AutoDream for long-term memory distillation.
- **Computer Use**: let the agent screenshot, click, type, and control desktop apps after authorization.
- **MCP support**: connect MCP tools and external capabilities.

### More

- **Permission modes**: five levels, from "ask every time" to "skip permissions" — risky commands and tool calls are approved in the GUI.
- **Bring your own model**: add providers via API key with presets for DeepSeek, Kimi, Zhipu GLM and others, or point at LM Studio and Ollama running locally.
- **Three colour themes**: Pure White, Paper, and Ink Blue — optionally following the system light/dark setting.
- **Scheduled tasks & usage stats**: run planned tasks in their own sessions and track local token usage trends.

## Run the CLI from Source

For users who want to debug the underlying CLI, server, or local development flow:

```bash
bun install
cp .env.example .env
./bin/claude-heihei
```

See [environment variables](docs/en/cli/env.md) and [CLI setup](docs/en/cli/index.md) for more configuration options.

## More Documentation

| Section | Documents |
|------|------|
| **Getting started** | [What this is](docs/en/start/index.md) · [Download and install](docs/en/start/install.md) · [Connect a model provider](docs/en/start/models.md) · [Your first session](docs/en/start/first-session.md) · [Troubleshooting](docs/en/start/troubleshooting.md) |
| **Desktop features** | [Feature overview](docs/en/desktop/index.md) · [Computer Use](docs/en/desktop/computer-use.md) |
| **CLI** | [Install and run](docs/en/cli/index.md) · [Command reference](docs/en/cli/reference.md) · [Environment variables](docs/en/cli/env.md) |
| **Internals** | [Desktop architecture](docs/en/internals/desktop.md) · [Multi-agent system](docs/en/internals/agent.md) · [Skills system](docs/en/internals/skills.md) · [Memory system](docs/en/internals/memory.md) · [Computer Use architecture](docs/en/internals/computer-use.md) · [Local server and API](docs/en/internals/server.md) · [Channel system](docs/en/internals/channel.md) · [Project structure](docs/en/internals/structure.md) |

## Support

If this project helps you, consider supporting its ongoing development ❤️

<p align="center">
  <img src="docs/images/donate/wechat-pay.png" width="240" alt="WeChat Pay">
  <img src="docs/images/donate/alipay.jpg" width="240" alt="Alipay">
</p>

## Feedback & Contact

For questions, bugs, or feature suggestions, reach out via:

- Email: [511829667@qq.com](mailto:511829667@qq.com)
- GitHub Issues: [open an issue](https://github.com/KyuuKyuuStone/claude-code-heihei/issues)

## Tech Stack

| Category | Technology |
|------|------|
| Language | TypeScript |
| Desktop app | Electron |
| Desktop UI | React + Vite |
| Local runtime | [Bun](https://bun.sh) |
| Terminal UI | React + [Ink](https://github.com/vadimdemedes/ink) |
| CLI parsing | Commander.js |
| API | Anthropic SDK |
| Protocols | MCP, LSP |

## Acknowledgements

This project is built on the shoulders of the following projects:

- [cc-haha](https://github.com/NanmiCoder/cc-haha) — the upstream desktop workspace (MIT) this project is forked from. Thanks to NanmiCoder and the cc-haha community.
- [Claude Code](https://claude.com/claude-code) / [Anthropic](https://www.anthropic.com) — the underlying agent runtime and [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript).

Thanks also to [DeepSeek](https://www.deepseek.com) for assisting with the development and refactoring of this codebase, and to the following open-source projects and community practices for reference and inspiration:

- [React](https://github.com/facebook/react): frontend engineering and component-based UI ecosystem.
- [Electron](https://github.com/electron/electron): cross-platform desktop app capabilities and engineering practices.
- [cc-switch](https://github.com/farion1231/cc-switch): reference for model provider configuration.
- [LINUX DO](https://linux.do/): a new ideal developer community.
