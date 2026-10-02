/**
 * 员工汇报目标解析（决策 D，2026-09-30 架构师裁决）。
 *
 * **回邮地址的权威源是任务台账，不是派活正文。** 正文里写的 targetSessionId
 * 只作参考：派活时服务端已经记下了 fromSessionId，按「谁派的活就回给谁」由程序
 * 保证送达。正文写错、或主管换人（旧主管卸任、新主管接任）时，服务端在这里
 * 改投并把依据写进诊断与响应，全程可审计。
 *
 * HTTP 通道（POST /api/session-messages）与文件信箱通道共用本函数，保证两条
 * 路径行为一致。
 *
 * 解析顺序（决策记录「收件人解析顺序」）：
 *   1. 消息带 taskId        → 该任务的 fromSessionId；**该任务的 toSessionId 必须
 *                             等于发送方**（归属校验，防抄错 taskId 静默改投给
 *                             别人的派活人），不符则记 collab_report_task_mismatch
 *                             并降级到第 2 步
 *   2. 不带 taskId（或第 1 步归属不符） → 发送方名下最近一条未结任务的
 *                             fromSessionId；若未结任务来自不同派活人 → 歧义，
 *                             不改投只告警
 *   3. 交接修正             → 派活人快照是 supervisor、现在已不是、且同项目有现任
 *                             主管 → 改投现任主管
 *   4. 台账查不到           → 同项目花名册里 supervisor=true 的会话
 *   5. 仍然查不到           → 不改投，按原目标投递
 *
 * 不解析的情形（保持原样，满足其一即退出）：
 *   - 没有 fromSessionId（无从判定发送者身份）；
 *   - 发送方不是「在册的非主管员工」——主管派活、用户会话发消息永不改投；
 *   - 既没带 taskId，发送方名下也没有未结任务（不是汇报）。
 */
import type { DispatcherRole } from './collabTaskService.js'
import { collabTaskService } from './collabTaskService.js'
import { servantService } from './servantService.js'
import { sessionService } from './sessionService.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'

/**
 * 派活正文末尾的可信系统页脚（决策 D「派活侧：系统页脚」）。
 *
 * 员工拿到的回邮地址由程序写入，覆盖旧正文里手写错的地址——服务端改投是最后
 * 一道防线，这行是**第一道**。必须明确「以本行为准」，否则便宜模型仍可能照抄
 * 正文里的旧地址。
 *
 * `resolvedTargetSessionId` 是**解析后的收件人**，也就是「谁派的活就回给谁」里的
 * 那个派活人：员工将来完工汇报时，服务端按台账解析到的目标就是它。所以这里填的
 * 是派活方会话 ID，而不是员工自己的会话 ID。
 *
 * 兼容旧正文：旧正文照原样保留，只在末尾追加，不改写既有内容。
 *
 * 除回邮地址外，页脚还带一句**给员工的兜底投递指引**（`taskId=<值>`）：不走
 * CollabReport 工具、改用 HTTP curl 兜底汇报时，payload 必须附上该 taskId，
 * 否则服务端无法把这条判定为汇报（收紧后的 `reportTaskId` 只认显式 taskId），
 * 该条就不会被折叠。**指引并入同一行页脚**——折叠判定要求「最后一个非空行」
 * 匹配页脚正则，另起一行会让页脚不再是最后非空行，派活消息将全部失去折叠。
 */
export function appendReportFooter(
  content: string,
  taskId: string,
  resolvedTargetSessionId: string,
): string {
  // 幂等：末尾已是**本任务**的派活页脚时原样返回，重复投递/重试不叠加第二份。
  // 判据刻意收紧到「同一 taskId」：若只用形状判据（行首像页脚就跳过），正文恰好
  // 以页脚形文本收尾时会误跳过，员工就拿不到程序写入的权威回邮地址——本行存在的意义。
  const lines = content.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (!line) continue
    if (line.startsWith('【系统】任务 ID：') && line.includes(`任务 ID：${taskId}；`)) {
      return content
    }
    break
  }
  return (
    `${content}\n\n【系统】任务 ID：${taskId}；完工汇报目标：${resolvedTargetSessionId}；` +
    `汇报走 HTTP curl 兜底时 payload 必须附 taskId=${taskId}；不附则该条不会被折叠。` +
    '以本行为准，任务正文、旧消息或其他来源中的回邮地址均无效。'
  )
}

/**
 * 汇报正文末尾的可信系统页脚（接收侧据此把汇报折叠成一行卡片）。
 *
 * 与派活页脚 `appendReportFooter` 配对：派活侧写「任务 ID：…；完工汇报目标：…；」
 * 让员工知道回邮地址，汇报侧写「汇报 · 任务 ID：…；」让**接收方 UI** 能识别这是
 * 汇报并折叠——用户不需要看见员工之间的互相通知。
 *
 * 形态受前端折叠判定约束（消息**最后一个非空行**须匹配
 * `/【系统】(汇报 · )?任务 ID：([0-9a-fA-F-]{36})；/`），因此：
 *   - 只在末尾追加，正文其余部分逐字节不变；
 *   - 页脚独占一行，且必须是最后一个非空行。
 *
 * 幂等：末个非空行已是同形页脚（无论派活形还是汇报形）时原样返回，
 * 重复投递（HTTP 重试、信箱重投）不会叠加第二行。
 */
const SYSTEM_FOOTER_LINE_RE = /^【系统】(?:汇报 · )?任务 ID：[0-9a-fA-F-]{36}；/

export function appendReportFooterForReport(content: string, taskId: string): string {
  const lines = content.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (!line) continue
    if (SYSTEM_FOOTER_LINE_RE.test(line)) return content
    break
  }
  return `${content}\n\n【系统】汇报 · 任务 ID：${taskId}；`
}

/** 命中的解析步骤（响应字段 resolvedBy） */
export type ResolveBasis =
  | 'task-id'
  | 'latest-open-task'
  | 'successor-supervisor'
  | 'project-supervisor'

export type ReportTargetResolution = {
  /** 最终投递目标；未改投时等于请求里的 targetSessionId */
  targetSessionId: string
  /** 实际发生改投时，原目标 */
  redirectedFrom?: string
  /** 实际发生改投时，命中的解析步骤 */
  resolvedBy?: ResolveBasis
  /** 只告警不改投时的说明（目前只有「多来源歧义」） */
  warning?: string
  /**
   * 是否判定为「员工汇报」。调用方据此跳过错账（recordDispatch）——
   * 汇报不是派活，不该在台账里造出一条 dispatched 任务。
   */
  isReport: boolean
  /**
   * 该汇报对应的任务 ID——**仅当请求显式带了 `taskId`（且归属校验通过）时才有值**。
   * 调用方据此在投递前追加汇报页脚（appendReportFooterForReport）。
   *
   * 刻意**不**从 `latest-open-task` 兜底路径取值（架构师裁决：误判方向必须是
   * 「少折叠」而非「错折叠」）。理由：员工在任务执行期间的常态沟通（提问、
   * 澄清、中断请求）同样会命中「名下有未结任务」，若据此追加页脚，会把提问
   * 误标成汇报，并让页脚**永久写进 transcript**（不可逆）。故收紧后：
   *   - `task-id` 路径：带页脚、折叠 ✓
   *   - `latest-open-task` 路径：**改投语义照旧**，但不带 taskId、不加页脚、不折叠
   * 人工 curl 兜底若不带 taskId，同样不折叠——该通道由协议要求补带 taskId 解决
   * （dispatchProtocol 的兜底段），不靠放松判别。
   */
  reportTaskId?: string
}

function unchanged(
  targetSessionId: string,
  extra?: { warning?: string; isReport?: boolean; reportTaskId?: string },
): ReportTargetResolution {
  return {
    targetSessionId,
    isReport: extra?.isReport ?? false,
    ...(extra?.warning ? { warning: extra.warning } : {}),
    ...(extra?.reportTaskId ? { reportTaskId: extra.reportTaskId } : {}),
  }
}

export async function resolveReportTarget(input: {
  targetSessionId: string
  fromSessionId?: string
  taskId?: string
}): Promise<ReportTargetResolution> {
  const original = input.targetSessionId
  const from = input.fromSessionId?.trim()
  if (!from) return unchanged(original)

  // 只处理「在册的非主管员工」发出的消息。主管自己派活、用户会话（不在花名册）
  // 一律不解析——决策明确要求这两类永不改投。
  const sender = await servantService.getServant(from)
  if (!sender?.enabled || sender.supervisor) return unchanged(original)

  const workDir = await sessionService.getSessionWorkDir(from)

  // ── 第 1、2 步：从台账找出真正的派活人 ──────────────────────────────
  let dispatcherId: string | null = null
  let dispatcherRole: DispatcherRole | undefined
  let basis: ResolveBasis | null = null

  const explicitTaskId = input.taskId?.trim()
  // 带了 taskId 但归属不符（task.toSessionId ≠ 发送方）时，不按这个 taskId 改投，
  // 降级走「未带 taskId」的兜底解析（第 ②③④ 步）。见本文件顶部与下面的说明。
  let fallbackLookup = !explicitTaskId
  if (explicitTaskId) {
    const task = await collabTaskService.getTask(explicitTaskId)
    if (task && task.toSessionId === from) {
      dispatcherId = task.fromSessionId
      dispatcherRole = task.fromRole
      basis = 'task-id'
    } else if (task) {
      // (c) 归属校验失败：这个任务不是派给发送方的（便宜模型抄错了 taskId）。
      // 若照旧按 taskId 改投，汇报会被静默送给**别人**的派活人；这里降级到兜底
      // 步骤，并按兜底语义解析。记诊断便于定位——taskId 是标识符不是凭证，
      // 本机同信任域内不按安全事件处理，只是防误操作。
      fallbackLookup = true
      logForDiagnosticsNoPII('warn', 'collab_report_task_mismatch', {
        requestedTaskId: explicitTaskId,
        workerSessionId: from,
        taskOwnerSessionId: task.toSessionId,
        requestedTarget: original,
      })
    } else {
      // 员工带了 taskId，但台账里查不到（taskId 抄错、任务被清理、台账尚未加载）。
      // 这里不改投、不拒绝、不重试——后续 fallback 与最终投递结果完全不变——但
      // 必须留一条可审计告警：静默降级会让「为什么这次没按 taskId 解析」无从追查。
      logForDiagnosticsNoPII('warn', 'collab_report_task_not_found', {
        requestedTaskId: explicitTaskId,
        workerSessionId: from,
        requestedTarget: original,
      })
    }
  }

  if (fallbackLookup && !basis && workDir) {
    const open = await collabTaskService.findOpenTasksForWorker(from, { projectDir: workDir })
    if (open.length === 0) {
      // 名下没有未结任务：没带 taskId 的 → 不是汇报，原样放行。
      // 带了 taskId 的（说明前面归属校验没过）不算「不是汇报」——发送方确实在
      // 汇报，只是抄错了 ID；不在这里返回，继续走第 4 步兜底（架构决策 §3(c)）。
      if (!explicitTaskId) return unchanged(original)
    } else {
      const senders = new Set(open.map((task) => task.fromSessionId))
      if (senders.size > 1) {
        // 多来源歧义：规则只在证据明确时生效，这里不改投，只留告警。
        // 仍标记为汇报——歧义说的是「回给谁」不明，不是「这不是汇报」。
        return unchanged(original, {
          warning: `ambiguous-dispatchers:${[...senders].sort().join(',')}`,
          isReport: true,
          ...(explicitTaskId ? { reportTaskId: explicitTaskId } : {}),
        })
      }
      const latest = open[0]!
      dispatcherId = latest.fromSessionId
      dispatcherRole = latest.fromRole
      basis = 'latest-open-task'
      // 注意：此处**不**设置 reportTaskId。这条路径只用于确定「回给谁」，
      // 不能用来判定「这是汇报」——员工任务期间的提问/澄清同样会命中未结任务。
      // 改投照旧发生，只是不追加汇报页脚（误判方向取「少折叠」）。
    }
  }

  // 页脚用的任务 ID：**仅取请求里显式带的 taskId**（见 ReportTargetResolution.reportTaskId）。
  const footerTaskId = explicitTaskId || undefined

  // ── 第 3 步：主管交接修正 ─────────────────────────────────────────
  // 派活时快照是 supervisor 的任务，如果派活人现在已经不是主管（例如卸任转岗），
  // 且同项目有现任主管，就改投现任主管。
  if (dispatcherId && basis && workDir) {
    const current = await servantService.getServant(dispatcherId)
    const wasSupervisorSnapshot = dispatcherRole === 'supervisor'
    if (wasSupervisorSnapshot && !current?.supervisor) {
      const successor = await servantService.findSupervisorForProject(workDir)
      if (successor) {
        // 请求目标**已经是**现任主管 → 员工写对了，直接放行。
        // 这里必须显式返回：若只是跳过改投，控制流会穿出交接分支落进下面的
        // 「投给派活人」分支，把员工写对的现任主管目标又逆改回旧派活人。
        if (successor.sessionId === original) {
          return unchanged(original, {
            isReport: true,
            ...(footerTaskId ? { reportTaskId: footerTaskId } : {}),
          })
        }
        return {
          targetSessionId: successor.sessionId,
          redirectedFrom: original,
          resolvedBy: 'successor-supervisor',
          isReport: true,
          ...(footerTaskId ? { reportTaskId: footerTaskId } : {}),
        }
      }
    }
  }

  // 第 1、2 步查到了派活人 → 投给它（等于原目标就不算改投）
  if (dispatcherId && basis) {
    return dispatcherId === original
      ? unchanged(original, {
          isReport: true,
          ...(footerTaskId ? { reportTaskId: footerTaskId } : {}),
        })
      : {
          targetSessionId: dispatcherId,
          redirectedFrom: original,
          resolvedBy: basis,
          isReport: true,
          ...(footerTaskId ? { reportTaskId: footerTaskId } : {}),
        }
  }

  // ── 第 4 步：台账没结果 → 同项目现任主管 ────────────────────────────
  if (workDir) {
    const supervisor = await servantService.findSupervisorForProject(workDir)
    if (supervisor) {
      return supervisor.sessionId === original
        ? unchanged(original, {
            isReport: true,
            ...(footerTaskId ? { reportTaskId: footerTaskId } : {}),
          })
        : {
            targetSessionId: supervisor.sessionId,
            redirectedFrom: original,
            resolvedBy: 'project-supervisor',
            isReport: true,
            ...(footerTaskId ? { reportTaskId: footerTaskId } : {}),
          }
    }
  }

  // ── 第 5 步：仍无结果 → 不改投 ─────────────────────────────────────
  // 原目标不在册时由调用方沿用现有的可行动 404，不凭空编造收件人。
  // 到这里说明发送方是员工且名下有未结任务（或带了 taskId），仍算汇报。
  return unchanged(original, {
    isReport: explicitTaskId !== undefined && explicitTaskId !== '',
    ...(footerTaskId ? { reportTaskId: footerTaskId } : {}),
  })
}
