---
title: Session collaboration and task ledger
nav_title: Collaboration
description: Set up supervisor and worker sessions and use native tools to dispatch, report, review, and rework tasks.
order: 9
---

# Session collaboration and task ledger

Session collaboration lets a supervisor session delegate and review work while worker sessions execute tasks and report back. Since v1.6.0, native collaboration tools and the task ledger cover dispatch, execution, delivery, and review. Treat the ledger—not whether a session appears busy—as the source of task status.

## Supervisors and workers

Collaboration identities are isolated by project work directory. A project can have a supervisor and workers: the supervisor assigns, reviews, and summarizes work; workers execute tasks according to their roles and descriptions. Ordinary sessions do not receive collaboration tools.

Supervisor sessions can call:

- `CollabDispatch` to dispatch work.
- `CollabReview` to approve or request rework.
- `CollabListTasks` to inspect the ledger.

Worker sessions can call:

- `CollabReport` to report completed work.
- `CollabListTasks` to inspect their assigned tasks. Workers do not receive dispatch or review tools.

Tools are injected by collaboration role: supervisors receive 3, workers receive 2, and ordinary sessions receive none. See `src/collaboration/collabToolContract.ts:31-73`; role injection is tested in `src/server/__tests__/collab-cli-tools.test.ts:782-851`.

## Typical workflow

### 1. The supervisor dispatches a task

The supervisor checks the project roster and chooses a worker whose role and description fit the task, then calls:

```text
CollabDispatch({
  to: "worker sessionId or unique role name",
  title: "optional title",
  content: "context, deliverables, and acceptance criteria"
})
```

If a role name matches multiple workers, use a session ID. Normally omit `taskId`; the tool generates and returns one. Reuse an existing `taskId` only when resending for rework or retrying idempotently. Do not put a return address in the dispatch content: the server appends a system footer with the task ID and the only valid completion-report target. Workers must use that footer; if it is missing or unreadable, stop and tell the dispatcher rather than guessing. The server also resolves and corrects the report target from the ledger. Evidence: `src/tools/CollabTools/CollabDispatchTool.ts:37-49`, `src/server/services/reportTargetResolver.ts:32-53`, and `src/server/__tests__/servants.test.ts:802-813`.

### 2. The worker executes and reports

After completing the task, the worker calls:

```text
CollabReport({
  taskId: "task ID returned by dispatch",
  summary: "conclusion and verification evidence",
  deliverables: ["output file path"]
})
```

If `taskId` is omitted, the tool selects a task only when the worker has exactly one open task. With multiple candidates it lists them and requires an explicit choice; it does not guess. The report first attempts to advance the ledger to `delivered`, then sends the report to the dispatcher. After a supervisor handoff, the server may resolve the current supervisor in the same project as the recipient. Implementation: `src/tools/CollabTools/CollabReportTool.ts:170-203,245-258` and `src/server/services/reportTargetResolver.ts:12-24,149-196`.

### 3. The supervisor reviews or requests rework

After the report arrives, the supervisor uses the task ID to call:

```text
CollabReview({ taskId: "task ID", verdict: "pass" })
```

To request rework, include an explanation:

```text
CollabReview({ taskId: "task ID", verdict: "rework", note: "Add the missing tests" })
```

The tool sends a rework message to the original worker under the same task ID; it does not create a new ledger task. The worker can resume, execute, and report again. Only a `delivered` task can be reviewed; if the status has not advanced, the tool returns `not_reviewable`. `note` is required for `rework`. Evidence: `src/tools/CollabTools/CollabReviewTool.ts:38-49` and `src/server/__tests__/collab-cli-tools.test.ts:638-681`.

### 4. Inspect the ledger

```text
CollabListTasks({ status: "open", limit: 20 })
```

Without filters, the tool returns a summary ordered by most recently updated. `status: "open"` includes `dispatched`, `accepted`, `in_progress`, `rework`, and `delivered`. Workers can only see tasks assigned to themselves. Provide `taskId` to read that task's full content and report. Schema and implementation: `src/tools/CollabTools/CollabListTasksTool.ts:35-48` and `src/collaboration/collabToolContract.ts:75-113`.

## Task statuses

| Status | Meaning |
|---|---|
| `dispatched` | The dispatch message was delivered and recorded; the worker has not yet been observed starting it. |
| `accepted` | The server observed a start signal for the worker session; this does not precisely identify a specific task. |
| `in_progress` | The server observed a start signal for the worker session and advanced its in-flight tasks; this does not precisely identify a specific task. |
| `delivered` | The worker submitted a report. |
| `rework` | The supervisor requested changes; the worker can resume the task. |
| `verified` | The supervisor approved the work; terminal. |
| `failed` | The task was marked failed; terminal. |
| `cancelled` | The task was cancelled; terminal. |

The normal path is `dispatched → accepted → in_progress → delivered → verified`. Rework follows `delivered → rework → in_progress → delivered`, after which the supervisor can review again. `verified`, `failed`, and `cancelled` have no outgoing transitions. An approved task cannot return to `rework`; dispatch a new task to continue. Status definitions and transitions: `src/server/services/collabTaskService.ts:35-43,84-108`; tests: `src/server/__tests__/collab-task-service.test.ts:48-105`.

`accepted` and `in_progress` mean the server has observed a start signal for the **worker session**; they do not prove that a particular task received its own start signal. A task dispatched while the worker is busy may remain `dispatched`; when reported in that state, the server catches it up through `accepted` and `in_progress` to `delivered` at report time. The two catch-up history entries use the fixed note `汇报时补推进：回合中途入队未收到开工信号` and `by: system`; all three history entries share the report timestamp, and only the final `delivered` status is pushed. Implementation: `src/server/services/collabTaskService.ts:471-519,527-582,643-694`; tests: `src/server/__tests__/collab-task-service.test.ts:210-238,355-401`.

These are **ledger-layer** records. At the **panel layer**, the status badge may jump directly from **待接单** (`dispatched`) to **已交付** (`delivered`); task details do not render general history entries and therefore do not show the catch-up note. Panel implementation: `desktop/src/pages/CollabTasks.tsx:15-24,169-183,188-205`.

## Broadcast dispatch

A supervisor or non-worker session can broadcast to all enabled workers in the project. Each worker receives an independent task ID and ledger record; `broadcastId` associates the tasks created by one broadcast. Same-ID concurrent requests are serialized only within one server process and reuse targets already delivered successfully. Do not rely on cross-process or multi-instance idempotency. Tests: `src/server/__tests__/servants.test.ts:1169-1355`.

## Offline delivery and the file mailbox

When the server is unavailable, `CollabDispatch` and `CollabReport` can write JSON payloads into the project's `.heihei/dispatch/` directory. The desktop service consumes them after recovery. Dispatch payloads retain the same `taskId` so retries can be recorded idempotently. Report payloads can include report data, which the server records before delivering the message. Evidence: `src/tools/CollabTools/CollabDispatchTool.ts:115-166`, `src/tools/CollabTools/CollabReportTool.ts:119-158,207-212`, and `src/server/services/dispatchMailboxService.ts:379-405`.

A tool result with `queued` means only that a payload was queued; it does not confirm delivery or that the worker started. Do not dispatch or report again just because it is queued. `Review` is a review operation and `ListTasks` is read-only; neither uses the mailbox when the server is unreachable. The file mailbox does not support broadcast. Tests: `src/server/__tests__/collab-cli-tools.test.ts:427-449,542-558,692-704` and `src/server/__tests__/dispatch-mailbox.test.ts:127-160`.

Mixing new CLI tools with an old server that lacks ledger support is not a supported configuration. Dispatch/report may deliver a message without a ledger. On the old-server report fallback, delivery is allowed only when the same-project roster identifies exactly one supervisor; otherwise it is rejected. Review and task listing require a server with ledger support. Tests: `src/server/__tests__/collab-cli-tools.test.ts:401-409,560-634`.

## Collaboration context after compaction

After a session's context is compacted (`/compact`), a collaboration session automatically re-injects a **collaboration context card**: the key collaboration facts that were dropped — the rules digest, the roster, a task overview, and the worker's current task — **trimmed by role (supervisor / worker)** so the session doesn't "forget who it is and what it should do" after compaction. **On by default**; set `CC_HEIHEI_COLLAB_CONTINUATION=0` to turn it off (when disabled, or for non-collaboration sessions, it does no probing, no request, and no injection). Implementation: `src/collaboration/collabContextAttachment.ts`; hook: `src/services/compact/compact.ts`.

Since v1.7.2, permission waits are bounded. If nobody answers a permission request, the session no longer hangs forever: after **15 minutes with a client attached, or 90 seconds with no client**, the request is **auto-denied** and the turn continues with the tool reported as rejected (**the tool does not run**). When this happens, the message stream shows a neutral grey system note (five UI languages) stating the request was auto-denied and the tool was not executed; a separate static hint appears while waiting, with **no countdown**.

The attached-client tier is longer (15 minutes) because attaching a client only **extends** the timer, and disconnecting does not shorten it. Worker sessions are unaffected (they run unattended with permissions auto-approved, so no pending request is created). Evidence: `release-notes/v1.7.2.md`, commits `6264f59` (bounded timeout) and `a82b0e1` (visibility).

## Limitations

- The collaboration service defaults to local-only use on `127.0.0.1` and does not provide per-process authentication by default. Programs running locally with the same user permissions can read and write collaboration data. A `taskId` identifies a task; it is not an access credential and does not grant access control. Evidence: `src/server/index.ts:92-103,226-231,277-285` and `src/server/localRequestPolicy.ts:281-307`.
- `broadcastId` locking is process-local; concurrent idempotency across multiple server processes or instances is not guaranteed.
- Repeating `pass` on a `verified` task succeeds with an `already_final` warning. A different review result on a closed task (such as requesting rework after approval) returns `409`. Terminal tasks cannot be reopened; dispatch a new task to continue. Tests: `src/server/__tests__/collab-cli-tools.test.ts:683-690` and `src/server/__tests__/collab-task-service.test.ts:85-105`.
- A report on a task still in `dispatched` can be accepted and catch the task up to `delivered` as described in the task-status section. Review still requires a delivered task; report/review tests: `src/server/__tests__/collab-task-service.test.ts:355-401` and `src/server/__tests__/collab-cli-tools.test.ts:667-681`.
- Use the `taskId` in the matching dispatch footer when reporting; do not guess from task content or old messages. If you copy another worker's task ID, HTTP reporting will not redirect by that ID; the server falls back to your own open task's dispatcher, or to the current project supervisor when you have no open task identifying a dispatcher. If your open tasks have multiple dispatchers, it keeps the original target rather than guessing. A mailbox report will not advance another worker's task, but the message is still delivered. Your actual task is not advanced to `delivered`, so supervisor review returns `409` because it has not been delivered. This is an operational-error safeguard, not access control. Implementation/tests: `src/server/services/reportTargetResolver.ts:115-170,208-227`, `src/server/__tests__/report-target-resolver.test.ts:103-146,224-270`, `src/server/services/dispatchMailboxService.ts:382-424`, and `src/server/__tests__/dispatch-mailbox.test.ts:238-290`.

  An unknown `taskId` is different: it records `collab_report_task_not_found` and does not redirect by that ID or fall back to another open task. Missing/blank `fromSessionId` leaves the HTTP target unchanged without a mismatch diagnostic; on the mailbox path it prevents ledger advancement, but the message is still delivered and the sender is logged as `unknown`. Supervisor-originated messages are not resolved as employee reports. Tests: `src/server/__tests__/report-target-resolver.test.ts:172-222,272-293` and `src/server/__tests__/dispatch-mailbox.test.ts:292-350`.
- When a task remains `dispatched`, a valid employee report can catch it up to `delivered`; reports that fail caller or content validation are still rejected. Catch-up and caller validation: `src/server/services/collabTaskService.ts:471-519` and `src/server/api/collabTasks.ts:124-174`; tests: `src/server/__tests__/collab-task-service.test.ts:355-401` and `src/server/__tests__/collab-tasks-api.test.ts:402-455`. Review still requires a delivered task: `src/server/__tests__/collab-cli-tools.test.ts:667-681`.
- **The task panel is desktop-only.** It is opened from the desktop runtime's tab bar. In a mobile browser, selecting a non-session tab returns to an existing session tab, or to the empty/chat entry point when no session exists. Evidence: `desktop/src/components/layout/TabBar.tsx:277-280` and `desktop/src/components/layout/AppShell.tsx:180-189`; test: `desktop/src/components/layout/AppShell.test.tsx:449-464`.
- With no active session and no project directory, the panel does not request the task list or guess a directory; it shows an empty state. It still issues a `whoami` probe to determine connection state, and shows a frosted reconnect overlay when the service is not ready. Implementation: `desktop/src/pages/CollabTasks.tsx:71-95,143-165` and `desktop/src/stores/collabTaskStore.ts:125-127,169-171`.
- When more work is dispatched to a worker who is already processing a task, the new task may initially show **待接单** (`dispatched`) and then jump directly to **已交付** (`delivered`) when the worker reports. The panel detail shows the task request, deliverables, report, review verdict, and rework notes; it does not render general history entries, so it does not show the catch-up note. Implementation: `desktop/src/pages/CollabTasks.tsx:15-24,169-183,188-205`; ledger history behavior and tests are documented in [the task-status section](#task-statuses) and `src/server/__tests__/collab-task-service.test.ts:355-401`.
- The file mailbox does not support broadcast. Multi-instance broadcast idempotency and mixing new CLI tools with old servers are outside the supported guarantees.
