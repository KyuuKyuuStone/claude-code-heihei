---
title: Local Server and API
nav_title: Local Server
description: Startup flags, access control, REST surface, and chat WebSocket of the local server.
order: 2
---

# Local Server and API

The local server is the runtime boundary between Desktop and the Claude CLI. It provides REST APIs, the chat WebSocket, and provider protocol translation. The packaged Desktop app manages it automatically. Start it manually only for source development or headless deployment.

## Start the server

From the repository root:

```bash
bun run src/server/index.ts
```

It listens on `127.0.0.1:3456` by default. Check readiness with:

```bash
curl http://127.0.0.1:3456/health
```

Response shape:

```json
{
  "status": "ok",
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

`/health` is an always-public startup probe. A successful response does not prove that another endpoint is authenticated.

## Startup options

| Option | Environment variable | Default | Description |
|--------|----------------------|---------|-------------|
| `--host <host>` | `SERVER_HOST` | `127.0.0.1` | Listen address |
| `--port <port>` | `SERVER_PORT` | `3456` | HTTP and WebSocket port |
| `--cli-path <path>` | `CLAUDE_CLI_PATH` | Automatically resolved | CLI started by the server |
| `--auth-required` | `SERVER_AUTH_REQUIRED=1` | Off | Require explicit authentication for capability endpoints |

Command-line host and port values take precedence over environment variables. Keep the loopback address for development. Listening on `0.0.0.0` accepts external connections but does not configure authentication, TLS, or a reverse proxy.

## Serve static assets

For a source launch, build the Desktop web assets first:

```bash
cd desktop
bun run build
cd ..
bun run src/server/index.ts
```

The server automatically finds `desktop/dist` in the repository. When starting from another directory, provide the absolute build path:

```bash
CLAUDE_H5_DIST_DIR=/absolute/path/to/desktop/dist \
  bun run /absolute/path/to/src/server/index.ts
```

## Access control

The server classifies the source of each request before granting access to a capability path:

| Request | Default behavior |
|---------|------------------|
| `GET /health` | Public startup probe |
| Direct loopback request | Trusted only when client address, Host, and Origin are local and no proxy-trace header is present |
| `--auth-required` / `SERVER_AUTH_REQUIRED=1` | Requires explicit authentication for capability endpoints |

A TCP peer address of `127.0.0.1` does not prove that the end user is local. A reverse proxy must preserve the public `Host` or send at least one of `Forwarded`, `X-Forwarded-*`, `X-Real-IP`, or `Via`, allowing the server to distinguish proxied traffic from direct loopback traffic.

### Passing tokens

- REST, provider proxy, and file endpoints: `Authorization: Bearer <token>`
- Browser WebSocket: `/ws/<session-id>?token=<token>`

Explicit `--auth-required` mode accepts a bearer token equal to the server's `ANTHROPIC_API_KEY`. Exposing a model credential for remote access is discouraged.

CORS restricts browser access to responses; it is not authentication. It does not make a non-browser client safe.

## HTTP API surface

Business REST APIs live under `/api/*` and cover:

- sessions, conversations, search, and filesystem access;
- settings, permissions, models, effort, and providers;
- agents, tasks, and teams;
- skills, plugins, and the market;
- Computer Use;
- diagnostics, Doctor, activity statistics, memory, and traces.

For exact request and response shapes, use the current handlers under `src/server/api/`. The internal `/sdk/<session-id>` WebSocket is used by the Claude CLI process started by the server; it is not a third-party client API.

`/proxy/*` is the provider protocol-translation boundary and depends on runtime authentication and model-routing state. Do not expose it as a general-purpose stateless OpenAI proxy.

## Chat WebSocket

Clients connect to:

```text
ws://127.0.0.1:3456/ws/<session-id>
```

Common client messages include:

- `user_message` and `stop_generation`;
- `permission_response` and `computer_use_permission_response`;
- `set_permission_mode` and `set_runtime_config`;
- `sync_state` and `prewarm_session`;
- `ping`.

The server sends connection and session state, text deltas, thinking, tool calls and results, permission requests, retry or fallback state, errors, task or team updates, and `pong`. Use `src/server/ws/events.ts` as the complete field contract.

The Desktop client sends a ping every 30 seconds and reconnects if no pong arrives within 10 seconds. Reconnect delay is capped at 30 seconds; it does not stop permanently after a fixed number of attempts. A custom client should reconnect, resynchronize state, and ignore unknown fields added to future messages.

## Reverse-proxy checklist

For remote use:

1. Use HTTPS so credentials are never sent over a public network in cleartext.
2. Proxy static assets, `/api/*`, `/proxy/*`, and `/ws/*`.
3. Enable WebSocket upgrade for `/ws/*`.
4. Preserve the public Host and standard proxy headers.
5. Do not expose the internal `/sdk/*` path.

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Port does not bind | Whether `SERVER_PORT` is occupied and contains a valid number |
| API or WebSocket returns `401` | Token is missing or stale, or the WebSocket lacks a query token |
| Browser reports CORS | The request's exact Origin is in the allowed-origin list |
| WebSocket reconnects repeatedly | Proxy upgrade support, token forwarding, and proxy idle timeouts |
| Page returns `404` | `desktop/dist` was not built or the static-asset path is wrong |
| Remote traffic is treated as local | The proxy removed both the public Host and every proxy-trace header |
