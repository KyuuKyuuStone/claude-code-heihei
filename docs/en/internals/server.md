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

The internal `/sdk/<session-id>` WebSocket is used by the Claude CLI process started by the server; it is not a third-party client API.

### Collaboration APIs and task ledger

The collaboration API consists of the roster, session-message delivery, and the task ledger. The ledger is routed under `/api/collab-tasks`; do not confuse it with the upstream CLI Task V2 API at `/api/tasks`. Implementations: `src/server/api/servants.ts` and `src/server/api/collabTasks.ts`. Behavior tests: `src/server/__tests__/servants.test.ts` and `src/server/__tests__/collab-tasks-api.test.ts`.

#### Roster: `/api/servant-sessions`

| Method and path | Behavior |
|---|---|
| `GET /api/servant-sessions` | Returns `{ servants, rosterTable }`. By default includes enabled members only; `?all=1` includes disabled entries; `?forSession=<sessionId>` restricts results to the same project as that session. |
| `PUT /api/servant-sessions/:sessionId` | Sets the session's collaboration identity. Include the current `enabled` value; supported fields include `role`, `description`, and `supervisor`. |
| `DELETE /api/servant-sessions/:sessionId` | Removes the collaboration identity and returns `{ ok: true }` on success. |

Implementation: `src/server/api/servants.ts:44-53,56-74,120-152`. When an old server has no ledger, the CLI's restricted report fallback can use the roster only if it identifies exactly one supervisor in the same project; zero/multiple supervisors or roster lookup failure are rejected. This does not make mixing new CLI tools with old servers a supported configuration. Tests: `src/server/__tests__/collab-cli-tools.test.ts:560-634`.

#### Message delivery and broadcast: `/api/session-messages`

| Method and path | Request and behavior |
|---|---|
| `POST /api/session-messages` (unicast) | Request `{ targetSessionId, content, fromSessionId?, taskId?, title? }`. A delivered request returns `201` with `messageId` and target information; successful dispatch also includes `taskId`. The server appends a system report footer to delivered dispatches and records them in the ledger idempotently by task ID. Delivery does not mean the target has consumed the message. |
| `POST /api/session-messages` (broadcast) | Request `{ broadcast: true, content, fromSessionId, broadcastId? }`. Sends individual messages and creates an independent task per enabled, non-supervisor worker in the same project (excluding the sender). The response includes `broadcastId`, `delivered`, `targets`, and a separate `taskId` for each successful target. The file mailbox does not support broadcast. |
| `GET /api/session-messages?messageId=<id>` | Looks up a delivery receipt and returns `{ ok, receipt }`; an unknown ID returns 404. Receipts are process-local. |
| `GET /api/session-messages?targetSessionId=<id>` | Returns up to the latest 20 receipts for that target as `{ ok, receipts }`. |

For employee reports, the server resolves the actual dispatcher from the task ID or the employee's open tasks, and can redirect to the current supervisor in the same project after a supervisor handoff. If open tasks point to multiple dispatchers, it warns without choosing one. A redirect response may include `redirectedFrom` and `resolvedBy`. Footer generation and resolution: `src/server/services/reportTargetResolver.ts:32-53,90-203`; HTTP handling: `src/server/api/servants.ts:203-245,281-346`; HTTP/mailbox parity tests: `src/server/__tests__/servants.test.ts:802-807` and `dispatch-mailbox.test.ts:91-125`.

An explicit `broadcastId` serializes same-ID requests only within one server process; successful targets are reused on retry while failed targets can be retried. Different IDs do not block each other; requests without an explicit ID are not locked. Cross-process/multi-instance idempotency is not guaranteed and is a known v1.7 boundary. See “Broadcast `broadcastId` idempotency boundary” below. Evidence: `src/server/services/broadcastLock.ts:1-39`, `src/server/api/servants.ts:401-414,445-531`, and `src/server/__tests__/servants.test.ts:1211-1355`.

#### Task ledger: `/api/collab-tasks`

| Method and path | Request and behavior |
|---|---|
| `GET /api/collab-tasks?project=<dir>&status=<status>` | Filters by the project directory resolved by the server with `path.resolve` and optional specific status; returns `{ tasks, projectDir }`, newest update first. `projectDir` echoes the resolved directory actually used for filtering. `status` accepts `dispatched`, `accepted`, `in_progress`, `delivered`, `verified`, `rework`, `failed`, or `cancelled`. |
| `GET /api/collab-tasks?forSessionId=<id>&status=<status>` | Resolves the project from the session's work directory, then optionally filters by status; the response's `projectDir` echoes the resolved filter directory. Returns 404 if no session work directory is available. |

When both `project` and `forSessionId` are omitted, existing behavior is preserved: no project filter is applied, all task records across projects on this machine are returned, and the response contains `projectDir: null`. This is not new in v1.6.1. Implementation: `src/server/api/collabTasks.ts:68-90`; tests: `src/server/__tests__/collab-tasks-api.test.ts:314-399`. If both are supplied, `project` takes precedence; see `src/server/api/collabTasks.ts:74-81`.
| `GET /api/collab-tasks/:id` | Returns `{ task }`; returns 404 if the task does not exist. |
| `POST /api/collab-tasks` | Explicitly creates a task. Requires `fromSessionId`, `toSessionId`, and `title`, plus either `project` or a resolvable `forSessionId`; optional `id` is the idempotency key. Repeating the same ID returns the original record without overwriting it. Normal CLI dispatch does not call this endpoint directly; it uses `POST /api/session-messages`, which records after delivery. |
| `POST /api/collab-tasks/:id/report` | Employee report request `{ summary, deliverables?, callerSessionId? }`; `summary` must be non-empty. If provided, `callerSessionId` must be the assignee; when omitted, the current version preserves compatibility and skips this caller check. Success returns `{ task }` and moves the task to `delivered`. |
| `POST /api/collab-tasks/:id/review` | Review request `{ verdict: "pass" | "rework", note?, callerSessionId? }`; if provided, `callerSessionId` must be the dispatcher or current project supervisor. `pass` moves to `verified`; `rework` moves to `rework`. Success returns `{ task }`. |

The normal task path is `dispatched` → `accepted` → `in_progress` → `delivered` → `verified`; rework is `delivered` → `rework` → `in_progress`. `failed`, `cancelled`, and `verified` are terminal and have no outgoing transitions. Illegal transitions return `409`. Repeating the same `pass` on a `verified` task remains successful at the HTTP layer; the CLI tool adds an `already_final` warning. A different verdict on a closed task (for example, rework after `verified`) returns `409`; create a new task to continue. A report on a task still in `dispatched` can be accepted and catch the task up to `delivered` as described below. A worker turn-start event advances tasks for that worker session through `accepted` to `in_progress`. Evidence: `src/server/services/collabTaskService.ts:471-519,643-694`; turn-start tests: `src/server/__tests__/collab-task-service.test.ts:210-238`; review rejects tasks not yet `delivered` in `src/server/__tests__/collab-cli-tools.test.ts:667-681`. Status definitions and normal transitions: `src/server/services/collabTaskService.ts:84-108,398-453` and `src/server/__tests__/collab-task-service.test.ts:48-113,85-105`.

`accepted` and `in_progress` mean the server has observed a start signal for that **worker session**; they do not precisely establish that a particular task received its own start signal. The turn-start event advances tasks associated with the worker session. If a worker reports a task that remains `dispatched`—for example, work queued while the worker was busy—the server catches it up in one report to `delivered` via `dispatched` → `accepted` → `in_progress` → `delivered`. The first two history entries use the fixed note `汇报时补推进：回合中途入队未收到开工信号` and `by: system`; all three entries share the report timestamp, and only the final `delivered` state is pushed. Implementation: `src/server/services/collabTaskService.ts:471-519,527-582`; tests: `src/server/__tests__/collab-task-service.test.ts:355-401`.

The ledger is persisted per project under `~/.claude/cc-heihei/tasks/<project-hash>.jsonl` and replayed on process startup. The client-generated task ID is shared by the dispatch footer and the ledger idempotency key. Evidence: `src/server/services/collabTaskService.ts:13-21,145-157,285-314`; persistence/idempotency tests: `src/server/__tests__/collab-task-service.test.ts:118-160`.

#### Capability negotiation: `GET /api/whoami`

Returns server identity and a `capabilities` string array. Current collaboration-related capabilities include `collab-tasks`, `report-caller-check`, `mailbox-report`, `broadcast-ledger`, and `broadcast-lock`. The `collab-context` capability advertises the collaboration context snapshot and is not a task-ledger endpoint. Clients use capability names to detect ledger, caller checks, mailbox report, and broadcast support. If an old server has no `capabilities` field, the CLI falls back to probing whether the collaboration ledger route returns the recognizable `404 Unknown API resource`. Capability names are additive; do not rename or remove existing names. Implementation: `src/server/services/serverIdentity.ts:37-70`; negotiation tests: `src/server/__tests__/api-router.test.ts:75-99`.

#### Trust boundary and limitations

The Desktop server defaults to the local loopback address `127.0.0.1`; protected API paths are rejected for requests outside the local trusted boundary by default. The general `--auth-required` / `SERVER_AUTH_REQUIRED` mode is not enabled by default in Desktop. Therefore, other programs running locally with the same user permissions remain inside the local trust boundary and can call the local API to read or modify collaboration data. Evidence: `src/server/index.ts:92-103,226-231,277-285` and `src/server/localRequestPolicy.ts:281-307`. A deployment may configure `CC_HEIHEI_LOCAL_ACCESS_TOKEN` for local requests, but this does not change the meaning of a task ID: **a `taskId` identifies a task; it is not an access credential**, and must not be treated as proof of access control.

`callerSessionId` is optional today. When present, `POST /api/collab-tasks/:id/report` checks that it is the assignee; `POST /api/collab-tasks/:id/review` checks that it is the dispatcher or the current project supervisor. If omitted, both endpoints skip caller identity checks. `GET /api/collab-tasks`, `GET /api/collab-tasks/:id`, and explicit `POST /api/collab-tasks` do not authenticate the caller. `/api/session-messages` uses request-body `fromSessionId` for collaboration semantics but does not authenticate the calling process. File-mailbox `report` payloads do not carry `callerSessionId`, and the mailbox service's `reportTask` call does not authenticate the operating process. Evidence: `src/server/api/collabTasks.ts:68-95,98-120,124-174,187-201`, `src/server/api/servants.ts:186-211`, and `src/server/services/dispatchMailboxService.ts:31-49,382-414`. Caller-check tests: `src/server/__tests__/collab-tasks-api.test.ts:79-137,142-248`.

#### Report task-ID ownership mismatch safeguards

For employee reports submitted through `POST /api/session-messages`, the server redirects by `taskId` to the recorded dispatcher only when the task's `toSessionId` matches the sender's `fromSessionId` (`resolvedBy=task-id`). If the task belongs to another employee, the server does not redirect by that ID; it records `collab_report_task_mismatch` and falls back to the sender's dispatcher when the sender's open tasks identify a single dispatcher, then to the current supervisor for the same project when the sender has no open task. If open tasks identify multiple dispatchers, it does not guess and keeps the original target. If the sender has open tasks from multiple dispatchers, the server does not guess and keeps the original target. Messages sent by a supervisor are not processed as employee reports. An unknown explicit task ID records `collab_report_task_not_found`, is not redirected by that ID, and does not trigger the mismatch fallback to another open task; the original resolution behavior is preserved. Missing or blank `fromSessionId` leaves the original target unchanged without redirect resolution or mismatch diagnostic. Implementation: `src/server/services/reportTargetResolver.ts:90-108,115-170,173-227`; tests: `src/server/__tests__/report-target-resolver.test.ts:103-121,123-146,148-192,194-222,224-270,272-293`.

The file-mailbox `report` path separately checks task ownership before advancing the ledger: it advances to `delivered` only when payload `fromSessionId` matches task `toSessionId`. A mismatch—including missing or blank sender ID—does not update that task, records `collab_report_task_mismatch` with `channel=mailbox` (using `unknown` when sender ID is missing or blank), and still delivers the report message. A matching sender proceeds normally. Implementation: `src/server/services/dispatchMailboxService.ts:382-424`; tests: `src/server/__tests__/dispatch-mailbox.test.ts:238-290,292-350`. This mailbox ledger guard and the `session-messages` report-target resolution are separate checks.

> User guidance: Use the `taskId` in the matching dispatch footer when reporting. If an agent copies another task's ID, the server will not redirect by that ID; HTTP resolution falls back to the sender's own open-task dispatcher, then to the current project supervisor when the sender has no open task to identify a dispatcher. If open tasks have multiple dispatchers, it keeps the original target rather than guessing. A mailbox report will not advance another worker's task, but the message is still delivered. The agent's actual task is not advanced to `delivered`, so supervisor review encounters `409` because the task has not been delivered. This is an operational-error safeguard, not access control. An unknown task ID is separate: it records `collab_report_task_not_found` without taking the mismatch fallback. Missing/blank `fromSessionId` leaves the HTTP target unchanged and cannot establish mailbox task ownership. Evidence is cited above.

The v1.7 plan is to require `callerSessionId`. If remote access is supported in the future, a local API token is planned as a prerequisite for expanding the trust boundary. Evidence: `src/server/api/collabTasks.ts:133-135`, `src/server/services/dispatchMailboxService.ts:41-49`, and architecture decision `D:/xxw_p/cc-heihei-plan/架构决策_taskId信任边界.md:35-42`.

### `broadcastId` idempotency boundary

A broadcast request to `POST /api/session-messages` may include `broadcastId`. Within a single server process, broadcasts with the same ID are serialized across idempotency checks, per-target delivery, and task recording. A later request with the same ID skips targets already delivered successfully and reuses their task results. If the earlier request succeeded for only some targets, a retry can still process the remaining targets. Requests without `broadcastId` are not locked; different IDs do not block one another.

This concurrent idempotency guarantee is **process-local only**. Concurrent requests with the same ID handled by multiple server processes or instances are not guaranteed to be idempotent against the shared task ledger. This is a known boundary planned for v1.7; do not rely on cross-process safety.

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
