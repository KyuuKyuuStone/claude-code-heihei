# Claude Code Heihei

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-horizontal-dark.png">
    <img src="docs/images/logo-horizontal.png" alt="Claude Code Heihei" width="480">
  </picture>
</p>

<div align="center">

[![License](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

**English** · [简体中文](README.zh-CN.md)

</div>

Claude Code Heihei is a **desktop Claude Code workspace** for macOS, Windows, and Linux. On top of the classic session workspace it adds a **session-level supervisor–worker collaboration** layer: appoint a supervisor, dispatch work to worker sessions, and collect their reports — all while keeping multi-session, project, diff review, permission approval, model setup, Computer Use, and scheduled tasks in one app.

## Highlights

- **Supervisor–worker collaboration**: appoint one supervisor per project and register worker sessions with free-form roles and traits (backend / frontend / writing / painter …). The supervisor dispatches tasks to workers, who run unattended and report back; the supervisor reviews the result and keeps going or delivers.
- **Project isolation**: the roster and dispatch are scoped by working directory — cross-project dispatch is rejected by the server.
- **Multi-session workspace**: tabs, project switching, terminal entry, and session history in one place.
- **Review edits file by file**: the workspace lists this turn's changes and opens any file as a syntax-highlighted diff, with per-turn undo.
- **Permission modes**: from "ask every time" to "skip permissions" — risky commands, tool calls, and follow-up questions are approved in the GUI.
- **Bring your own model**: add providers via API key with presets for DeepSeek, Kimi, Zhipu GLM and others, or point at LM Studio and Ollama running locally.
- **Three colour themes**: Pure White, Paper, and Ink Blue — optionally following the system light/dark setting.
- **Skill marketplace**: discover, preview, and install third-party skills from ClawHub / SkillHub, with source and safety status shown up front.
- **Computer Use**: let the agent take screenshots, click, type, and control desktop apps after authorization.
- **Scheduled tasks and usage stats**: run planned tasks in their own sessions and track local token usage trends.

## Install the Desktop App

1. Download the macOS / Windows / Linux desktop installer from your repository's Releases page.
2. On first launch, configure your model provider, API key, and default model in Settings.
3. macOS releases require signing and notarization. Draft or unsigned temporary builds may still need one-time manual approval. Unsigned Windows installers may show SmartScreen; click "More info" -> "Run anyway".

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
