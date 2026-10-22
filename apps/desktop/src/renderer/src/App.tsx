import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppUpdateSnapshot, PiStatus, SessionSummary } from '@shared/types'
import { Conversation } from './components/Conversation'
import { Composer } from './components/Composer'
import { IconRail } from './components/IconRail'
import { Sidebar } from './components/Sidebar'
import { TabBar } from './components/TabBar'
import { SettingsModal } from './components/SettingsModal'
import { SessionNavigator } from './components/SessionNavigator'
import { updateStatusText } from './lib/updates'
import {
  textFromBlocks,
  thinkingFromBlocks,
  toChatItems,
  toolCallsFromBlocks,
  type ChatItem,
  type ToolCallView
} from './lib/messages'

interface ToolCallPayload {
  id?: string
  toolCallId?: string
  name?: string
  toolName?: string
  arguments?: unknown
  args?: unknown
}

function partialToolCall(payload: ToolCallPayload, patch: Partial<ToolCallView>): ToolCallView {
  const args = payload.arguments ?? payload.args
  return {
    id: String(payload.id ?? payload.toolCallId ?? 'tool'),
    name: String(payload.name ?? payload.toolName ?? 'tool'),
    args: typeof args === 'string' ? args : args ? JSON.stringify(args, null, 2) : '',
    status: 'running',
    ...patch
  }
}

function mergeCall(current: ToolCallView, next: ToolCallView): ToolCallView {
  return {
    id: current.id,
    name: next.name && next.name !== 'tool' ? next.name : current.name,
    args: next.args || current.args,
    status: next.status || current.status,
    result: next.result ?? current.result,
    durationMs: next.durationMs ?? current.durationMs
  }
}

function resultText(result: unknown): string | undefined {
  if (typeof result === 'string') return result
  if (result && typeof result === 'object' && 'content' in result) {
    return textFromBlocks((result as { content?: unknown }).content)
  }
  return undefined
}

function patchLastAssistant(items: ChatItem[], patch: (item: ChatItem) => ChatItem): ChatItem[] {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].role === 'assistant') {
      const next = items.slice()
      next[index] = patch(next[index])
      return next
    }
  }
  return items
}

function upsertTool(items: ChatItem[], call: ToolCallView): ChatItem[] {
  let found = false
  const next = items.map((item) => {
    if (item.role !== 'assistant') return item
    const index = item.toolCalls.findIndex((existing) => existing.id === call.id)
    if (index === -1) return item
    found = true
    const toolCalls = item.toolCalls.slice()
    toolCalls[index] = mergeCall(toolCalls[index], call)
    return { ...item, toolCalls }
  })
  if (found) return next
  return patchLastAssistant(next, (item) => ({
    ...item,
    toolCalls: [...item.toolCalls, call]
  }))
}

function appendDelta(items: ChatItem[], field: 'text' | 'thinking', delta: string): ChatItem[] {
  if (!delta) return items
  return patchLastAssistant(items, (item) => ({ ...item, [field]: (item[field] ?? '') + delta }))
}

export default function App(): React.JSX.Element {
  const [status, setStatus] = useState<PiStatus>({ phase: 'starting', cwd: '' })
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activePath, setActivePath] = useState<string | undefined>(undefined)
  const [items, setItems] = useState<ChatItem[]>([])
  const [draft, setDraft] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [toast, setToast] = useState<string | null>(null)
  const [stick, setStick] = useState(true)
  const [activeUserIndex, setActiveUserIndex] = useState(0)
  const [update, setUpdate] = useState<AppUpdateSnapshot>({
    sequence: 0,
    status: 'idle',
    currentVersion: '0.0.0',
    latestVersion: null,
    notes: null,
    checkedAt: null,
    downloaded: 0,
    total: null,
    autoCheck: true,
    canInstall: false,
    releasesUrl: '',
    error: null
  })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<'providers' | 'custom' | 'general'>('providers')
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    localStorage.getItem('pi-desktop-theme') === 'light' ? 'light' : 'dark'
  )

  const statusRef = useRef(status)
  statusRef.current = status
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  stickRef.current = stick

  const userItems = useMemo(() => items.filter((item) => item.role === 'user'), [items])

  const updateActiveUser = useCallback(() => {
    const container = scrollRef.current
    if (!container || userItems.length === 0) return
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight
    if (distance < 24) {
      setActiveUserIndex(userItems.length - 1)
      return
    }
    const containerTop = container.getBoundingClientRect().top
    let active = 0
    userItems.forEach((item, index) => {
      const element = container.querySelector(
        `[data-message-id="${CSS.escape(item.id)}"]`
      ) as HTMLElement | null
      if (element && element.getBoundingClientRect().top - containerTop <= 120) {
        active = index
      }
    })
    setActiveUserIndex(active)
  }, [userItems])

  useEffect(() => {
    updateActiveUser()
  }, [items, updateActiveUser])

  const jumpToMessage = useCallback((itemId: string) => {
    const container = scrollRef.current
    const target = container?.querySelector(
      `[data-message-id="${CSS.escape(itemId)}"]`
    ) as HTMLElement | null
    if (!container || !target) return
    const top =
      target.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop -
      12
    container.scrollTo({ top, behavior: 'smooth' })
    setStick(false)
  }, [])

  const loadSessions = useCallback(async () => {
    try {
      setSessions(await window.pi.listSessions())
    } catch {
      setSessions([])
    }
  }, [])

  const loadMessages = useCallback(async () => {
    try {
      const messages = await window.pi.getMessages()
      setItems(toChatItems(messages))
      setStick(true)
    } catch {
      // ignore
    }
  }, [])

  const handleEvent = useCallback((record: Record<string, unknown>) => {
    const type = String(record.type ?? '')
    switch (type) {
      case 'message_start': {
        const message = record.message as { role?: string } | undefined
        if (message?.role === 'user') {
          setItems((prev) => {
            const index = prev.map((item) => item.role === 'user' && item.pending).lastIndexOf(true)
            if (index === -1) return prev
            const next = prev.slice()
            next[index] = { ...next[index], pending: false }
            return next
          })
        } else if (message?.role === 'assistant') {
          setItems((prev) => [
            ...prev,
            {
              id: `assistant-${Date.now()}-${prev.length}`,
              role: 'assistant',
              text: '',
              thinking: '',
              toolCalls: [],
              streaming: true
            }
          ])
        }
        break
      }
      case 'message_update': {
        const event = record.assistantMessageEvent as
          | { type?: string; delta?: string; toolCall?: ToolCallPayload }
          | undefined
        if (!event) break
        if (event.type === 'text_delta' && event.delta) {
          setItems((prev) => appendDelta(prev, 'text', event.delta!))
        } else if (event.type === 'thinking_delta' && event.delta) {
          setItems((prev) => appendDelta(prev, 'thinking', event.delta!))
        } else if (event.type === 'toolcall_end' && event.toolCall) {
          const call = partialToolCall(event.toolCall, { status: 'running' })
          setItems((prev) => upsertTool(prev, call))
        }
        break
      }
      case 'message_end': {
        const message = record.message as { role?: string; content?: unknown } | undefined
        if (message?.role === 'assistant') {
          setItems((prev) =>
            patchLastAssistant(prev, (item) => {
              const calls = toolCallsFromBlocks(message.content)
              return {
                ...item,
                text: textFromBlocks(message.content) || item.text,
                thinking: thinkingFromBlocks(message.content) || item.thinking,
                toolCalls:
                  calls.length > 0
                    ? calls.map((call) => {
                        const existing = item.toolCalls.find((entry) => entry.id === call.id)
                        return existing ? mergeCall(call, existing) : call
                      })
                    : item.toolCalls,
                streaming: false
              }
            })
          )
        } else if (message?.role === 'user') {
          setItems((prev) => {
            const index = prev.map((item) => item.role === 'user' && item.pending).lastIndexOf(true)
            if (index === -1) return prev
            const next = prev.slice()
            next[index] = {
              ...next[index],
              text: textFromBlocks(message.content) || next[index].text,
              pending: false
            }
            return next
          })
        }
        break
      }
      case 'tool_execution_start': {
        const call = partialToolCall(record as ToolCallPayload, { status: 'running' })
        setItems((prev) => upsertTool(prev, call))
        break
      }
      case 'tool_execution_update': {
        const payload = record as ToolCallPayload & { partialResult?: unknown }
        const call = partialToolCall(payload, {
          status: 'running',
          result: typeof payload.partialResult === 'string' ? payload.partialResult : undefined
        })
        setItems((prev) => upsertTool(prev, call))
        break
      }
      case 'tool_execution_end': {
        const payload = record as ToolCallPayload & { result?: unknown; isError?: boolean; durationMs?: number }
        const call = partialToolCall(payload, {
          status: payload.isError ? 'error' : 'done',
          result: resultText(payload.result),
          durationMs: payload.durationMs
        })
        setItems((prev) => upsertTool(prev, call))
        break
      }
      case 'agent_settled':
        setItems((prev) => prev.map((item) => ({ ...item, streaming: false })))
        void loadSessions()
        break
      case 'auto_retry_start':
        setToast(`模型请求失败，${String(record.delayMs ?? 0)}ms 后重试`)
        break
      case 'auto_retry_end':
        if (record.success === false) setToast(String(record.finalError ?? '重试失败'))
        break
      case 'extension_error':
        setToast(`扩展错误：${String(record.error ?? '未知错误')}`)
        break
      default:
        break
    }
  }, [loadSessions])

  useEffect(() => {
    void window.pi.getUpdateSnapshot().then(setUpdate)
    return window.pi.onUpdate(setUpdate)
  }, [])

  useEffect(() => {
    void window.pi.getStatus().then(setStatus)
    const offStatus = window.pi.onStatus(setStatus)
    const offEvent = window.pi.onEvent(handleEvent)
    return () => {
      offStatus()
      offEvent()
    }
  }, [handleEvent])

  useEffect(() => {
    if (status.phase === 'ready') {
      void loadSessions()
    }
  }, [status.phase, loadSessions])

  useEffect(() => {
    if (status.phase !== 'ready') return
    if (status.sessionFile) setActivePath(status.sessionFile)
    void loadMessages()
  }, [status.phase, status.sessionFile, loadMessages])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('pi-desktop-theme', theme)
    void window.pi.setTheme(theme)
  }, [theme])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (!stickRef.current) return
    const element = scrollRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [items])

  const send = useCallback(
    async (mode: 'send' | 'queue') => {
      const text = draft.trim()
      if (!text) return
      const streaming = statusRef.current.isStreaming
      const behavior = streaming ? (mode === 'queue' ? 'followUp' : 'steer') : undefined
      setDraft('')
      setStick(true)
      const localId = `local-${Date.now()}`
      setItems((prev) => [
        ...prev,
        { id: localId, role: 'user', text, toolCalls: [], pending: true }
      ])
      const result = await window.pi.prompt(text, behavior)
      if (!result.ok) {
        setItems((prev) => prev.filter((item) => item.id !== localId))
        setDraft(text)
        setToast(result.error ?? '发送失败')
      }
    },
    [draft]
  )

  const newSession = useCallback(async () => {
    const result = await window.pi.newSession()
    if (!result.ok) {
      setToast(result.error ?? '无法新建会话')
      return
    }
    setItems([])
    setActivePath(undefined)
    setDraft('')
    void loadSessions()
  }, [loadSessions])

  const selectSession = useCallback(
    async (session: SessionSummary) => {
      if (session.path === activePath) return
      if (session.cwd && session.cwd !== statusRef.current.cwd) {
        const next = await window.pi.openSession(session.path, session.cwd)
        if (next.phase === 'error') {
          setToast(next.error ?? '切换会话失败')
          return
        }
      } else {
        const result = await window.pi.switchSession(session.path)
        if (!result.ok) {
          setToast(result.error ?? '切换会话失败')
          return
        }
      }
      setActivePath(session.path)
      setStick(true)
      await loadMessages()
      void loadSessions()
    },
    [activePath, loadMessages, loadSessions]
  )

  const chooseWorkspace = useCallback(async () => {
    const next = await window.pi.chooseWorkspace()
    if (!next) return
    setItems([])
    setDraft('')
    setToast(`已在 ${next.cwd} 新建会话`)
  }, [])

  const newSessionInProject = useCallback(
    async (cwd: string) => {
      const next = await window.pi.newProjectSession(cwd)
      if (next.phase === 'error') {
        setToast(next.error ?? '无法切换到该项目')
        return
      }
      setItems([])
      setActivePath(undefined)
      setDraft('')
      setStick(true)
      setToast(`已在 ${cwd} 新建会话`)
      void loadSessions()
    },
    [loadSessions]
  )

  const restart = useCallback(async () => {
    const next = await window.pi.restart()
    if (next.phase === 'error') setToast(next.error ?? 'pi 启动失败')
    else setToast('pi 已重新启动')
  }, [])

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        void newSession()
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault()
        setSidebarOpen((value) => !value)
      }
      if ((event.ctrlKey || event.metaKey) && event.key === ',') {
        event.preventDefault()
        setSettingsOpen(true)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [newSession])

  const title =
    status.sessionName ||
    sessions.find((session) => session.path === activePath)?.title ||
    '新会话'

  return (
    <div className={`app ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
      <IconRail
        status={status}
        theme={theme}
        onNew={() => void newSession()}
        onToggleSidebar={() => setSidebarOpen((value) => !value)}
        onChooseWorkspace={() => void chooseWorkspace()}
        onOpenAgentDir={() => void window.pi.openAgentDir()}
        onOpenSettings={() => {
          setSettingsTab('providers')
          setSettingsOpen(true)
        }}
        onToggleTheme={() => setTheme((value) => (value === 'dark' ? 'light' : 'dark'))}
      />
      {sidebarOpen && (
        <Sidebar
          sessions={sessions}
          activePath={activePath}
          status={status}
          onNew={() => void newSession()}
          onSelect={(session) => void selectSession(session)}
          onNewInProject={(cwd) => void newSessionInProject(cwd)}
          onChooseWorkspace={() => void chooseWorkspace()}
          onCollapse={() => setSidebarOpen(false)}
        />
      )}
      <main className="main">
        <TabBar
          title={title}
          status={status}
          streaming={Boolean(status.isStreaming)}
          sidebarOpen={sidebarOpen}
          onNew={() => void newSession()}
          onToggleSidebar={() => setSidebarOpen((value) => !value)}
        />

        {status.phase === 'error' && (
          <div className="banner error">
            <div>
              <strong>pi 未连接</strong>
              <span>{status.error}</span>
              {status.stderrTail && <code>{status.stderrTail.split('\n').slice(-3).join('\n')}</code>}
            </div>
            <button onClick={() => void restart()}>重试</button>
          </div>
        )}

        {status.phase === 'ready' && !status.model && (
          <div className="banner warn">
            <div>
              <strong>pi 尚未登录</strong>
              <span>在设置里登录 Anthropic、OpenAI 等服务商，或配置自定义端点。</span>
            </div>
            <div className="banner-actions">
              <button
                onClick={() => {
                  setSettingsTab('providers')
                  setSettingsOpen(true)
                }}
              >
                去登录
              </button>
              <button onClick={() => void restart()}>重启 pi</button>
            </div>
          </div>
        )}

        {update.latestVersion &&
          ['available', 'downloading', 'preparing', 'installing'].includes(update.status) && (
            <div className="banner update">
              <div>
                <strong>
                  {update.status === 'available'
                    ? `发现新版本 ${update.latestVersion}`
                    : update.status === 'downloading'
                      ? '正在下载更新'
                      : '正在安装更新'}
                </strong>
                <span>
                  {update.status === 'available'
                    ? `当前 ${update.currentVersion} · 可在设置中下载安装`
                    : `${updateStatusText(update)} · 当前 ${update.currentVersion}`}
                </span>
              </div>
              <div className="banner-actions">
                <button
                  onClick={() => {
                    setSettingsTab('general')
                    setSettingsOpen(true)
                  }}
                >
                  查看更新
                </button>
              </div>
            </div>
          )}

        <div className="chat-area">
          <div
            className="scroll"
            ref={scrollRef}
            onScroll={(event) => {
              const element = event.currentTarget
              const distance = element.scrollHeight - element.scrollTop - element.clientHeight
              setStick(distance < 80)
              updateActiveUser()
            }}
          >
            <Conversation
              items={items}
              workspace={status.cwd}
              connected={status.phase === 'ready'}
              loggedIn={Boolean(status.model)}
              onSuggestion={(text) => {
                setDraft(text)
                requestAnimationFrame(() => {
                  const textarea = document.querySelector<HTMLTextAreaElement>('.composer textarea')
                  textarea?.focus()
                })
              }}
            />
          </div>
          {items.length > 0 && (
            <SessionNavigator
              items={items}
              activeUserIndex={activeUserIndex}
              onJump={jumpToMessage}
            />
          )}
        </div>

        <Composer
          value={draft}
          onChange={setDraft}
          onSend={(mode) => void send(mode)}
          onStop={() => void window.pi.abort()}
          streaming={Boolean(status.isStreaming)}
          disabled={status.phase !== 'ready'}
          status={status}
          onChooseWorkspace={() => void chooseWorkspace()}
        />

        {!stick && items.length > 0 && (
          <button
            className="jump-bottom"
            onClick={() => {
              setStick(true)
              const element = scrollRef.current
              if (element) element.scrollTop = element.scrollHeight
            }}
          >
            回到最新
          </button>
        )}

        {toast && (
          <div className="toast" onClick={() => setToast(null)}>
            {toast}
          </div>
        )}
      </main>

      <SettingsModal
        open={settingsOpen}
        initialTab={settingsTab}
        status={status}
        theme={theme}
        onThemeChange={setTheme}
        update={update}
        onCheckUpdate={() => void window.pi.checkForUpdates().then(setUpdate)}
        onInstallUpdate={() => void window.pi.installUpdate().then(setUpdate)}
        onCancelUpdate={() => void window.pi.cancelUpdateDownload().then(setUpdate)}
        onSetAutoUpdate={(enabled) => void window.pi.setAutoUpdateCheck(enabled).then(setUpdate)}
        onOpenReleases={() => void window.pi.openExternal(update.releasesUrl)}
        onClose={() => setSettingsOpen(false)}
        onRestart={restart}
        onChooseWorkspace={chooseWorkspace}
      />
    </div>
  )
}
