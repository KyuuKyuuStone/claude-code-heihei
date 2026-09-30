import { useEffect, type ReactNode } from 'react'
import { useTabStore } from '../../stores/tabStore'
import { EmptySession } from '../../pages/EmptySession'
import { ActiveSession } from '../../pages/ActiveSession'
import { ScheduledTasks } from '../../pages/ScheduledTasks'
import { Market } from '../../pages/Market'
import { Settings } from '../../pages/Settings'
import { TerminalSettings } from '../../pages/TerminalSettings'
import { TraceList } from '../../pages/TraceList'
import { TraceSession } from '../../pages/TraceSession'
import { SubagentRunPage } from '../../pages/SubagentRunPage'
import { CollabTasks } from '../../pages/CollabTasks'
import { WorkbenchTab } from '../workbench/WorkbenchTab'
import { previewBridge } from '../../lib/previewBridge'
import { returnToTraceList } from '../../lib/traceNavigation'

export function ContentRouter() {
  const activeTabId = useTabStore((state) => state.activeTabId)
  const tabs = useTabStore((state) => state.tabs)
  const activeTabType = tabs.find((tab) => tab.sessionId === activeTabId)?.type
  const terminalTabs = tabs.filter((tab) => tab.type === 'terminal')

  useEffect(() => {
    if (activeTabType === 'session' || activeTabType === 'workbench') return
    void previewBridge.close()
  }, [activeTabType])

  let page: ReactNode = null
  if (!activeTabId || !activeTabType) page = <EmptySession />
  else if (activeTabType === 'settings') page = <Settings />
  else if (activeTabType === 'scheduled') page = <ScheduledTasks />
  else if (activeTabType === 'market') page = <Market />
  else if (activeTabType === 'collab-tasks') page = <CollabTasks />
  else if (activeTabType === 'trace') {
    const traceId = tabs.find((tab) => tab.sessionId === activeTabId)?.traceSessionId
    page = traceId ? <TraceSession sessionId={traceId} onBack={() => returnToTraceList(activeTabId)} /> : <EmptySession />
  } else if (activeTabType === 'traces') page = <TraceList />
  else if (activeTabType === 'subagent') {
    const tab = tabs.find((item) => item.sessionId === activeTabId)
    page = tab?.sourceSessionId && tab.subagentToolUseId
      ? <SubagentRunPage sourceSessionId={tab.sourceSessionId} toolUseId={tab.subagentToolUseId} taskId={tab.subagentTaskId} title={tab.title} />
      : <EmptySession />
  } else if (activeTabType === 'workbench') {
    const tab = tabs.find((item) => item.sessionId === activeTabId)
    page = tab?.workbenchSessionId ? <WorkbenchTab tabId={activeTabId} sessionId={tab.workbenchSessionId} /> : <EmptySession />
  } else if (activeTabType !== 'terminal') page = <ActiveSession />

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      {page && <div className="absolute inset-0 z-10 flex min-h-0 flex-col overflow-hidden">{page}</div>}
      {terminalTabs.map((tab) => {
        const active = tab.sessionId === activeTabId
        const visible = activeTabType === 'terminal' && active
        return (
          <div key={tab.sessionId} aria-hidden={!visible} data-testid={`terminal-tab-panel-${tab.sessionId}`} className={`absolute inset-0 flex min-h-0 flex-col overflow-hidden ${visible ? 'z-20 opacity-100' : 'pointer-events-none z-0 opacity-0'}`}>
            <TerminalSettings active={active} cwd={tab.terminalCwd} runtimeId={tab.terminalRuntimeId ?? tab.sessionId} workspace testId={`terminal-host-${tab.sessionId}`} onNewTerminal={() => useTabStore.getState().openTerminalTab(tab.terminalCwd)} />
          </div>
        )
      })}
    </div>
  )
}
