import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppUpdateSnapshot,
  AskAnswer,
  AskRequest,
  McpState,
  PiStatus,
  SessionSummary,
  SideChatResult,
  SubagentView
} from '@shared/types'
import { Conversation } from './components/Conversation'
import { Composer } from './components/Composer'
import { IconRail } from './components/IconRail'
import { Sidebar } from './components/Sidebar'
import { TabBar } from './components/TabBar'
import { SettingsModal } from './components/SettingsModal'
import { SessionNavigator } from './components/SessionNavigator'
import { buildOutline } from './lib/outline'
import { AskQuestionPanel } from './components/AskQuestionPanel'
import { SubagentsDrawer } from './components/SubagentsDrawer'
import { RunStatusBar } from './components/RunStatusBar'
import { Markdown } from './components/Markdown'
import type { DraftImage } from './lib/images'

export interface BtwTurn {
  question: string
  answer?: string
  error?: string
}

/** The `/btw` panel: several turns on one fork, thrown away when the panel closes. */
export interface BtwChat {
  turns: BtwTurn[]
  busy: boolean
}

function isSubagentRunning(record: SubagentView): boolean {
  return record.status === 'starting' || record.status === 'streaming'
}

export interface QueuedMessage {
  id: string
  text: string
  images: DraftImage[]
}
import { updateStatusText } from './lib/updates'
import {
  imagesFromBlocks,
  NOTICE_TYPE,
  noticeText,
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
  const [draftImages, setDraftImages] = useState<DraftImage[]>([])
  // Messages written while a run is streaming: they wait here and are sent when it settles.
  const [queued, setQueued] = useState<QueuedMessage[]>([])
  const [btwChat, setBtwChat] = useState<BtwChat | undefined>(undefined)
  const [btwDraft, setBtwDraft] = useState('')
  const [mcpOpen, setMcpOpen] = useState(false)
  const [subagentsOpen, setSubagentsOpen] = useState(false)
  const [subagentFocus, setSubagentFocus] = useState<string | undefined>(undefined)
  const [subagents, setSubagents] = useState<SubagentView[]>([])
  const [mcpState, setMcpState] = useState<McpState | undefined>(undefined)
  const queueRef = useRef<QueuedMessage[]>([])
  useEffect(() => {
    queueRef.current = queued
  }, [queued])
  const [run, setRun] = useState<{
    startedAt?: number
    endedAt?: number
    runningTools: number
    tokens?: number
  }>({ runningTools: 0 })
  const [, setTick] = useState(0)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [toast, setToast] = useState<string | null>(null)
  const [stick, setStick] = useState(true)
  const [activeUserIndex, setActiveUserIndex] = useState(0)
  const [activeOutlineId, setActiveOutlineId] = useState<string | undefined>(undefined)
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
  const [settingsTab, setSettingsTab] = useState<'providers' | 'custom' | 'mcp' | 'general'>(
    'providers'
  )
  const [askQueue, setAskQueue] = useState<AskRequest[]>([])
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    localStorage.getItem('pi-desktop-theme') === 'light' ? 'light' : 'dark'
  )

  const statusRef = useRef(status)
  statusRef.current = status
  /** pi refuses prompts while it runs or compacts, so both count as busy everywhere. */
  const piBusy = useCallback(
    () => Boolean(statusRef.current.isStreaming || statusRef.current.compacting),
    []
  )
  const sessionsRef = useRef<SessionSummary[]>([])
  sessionsRef.current = sessions
  const historyRef = useRef<{ stack: string[]; index: number }>({ stack: [], index: -1 })
  const [historyNav, setHistoryNav] = useState({ canBack: false, canForward: false })
  const askQueueRef = useRef<AskRequest[]>([])
  askQueueRef.current = askQueue
  const btwChatRef = useRef<BtwChat | undefined>(undefined)
  btwChatRef.current = btwChat
  const ask = askQueue[0]
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  stickRef.current = stick

  const userItems = useMemo(() => items.filter((item) => item.role === 'user'), [items])
  const outline = useMemo(() => buildOutline(items), [items])

  const syncHistoryNav = useCallback(() => {
    const { stack, index } = historyRef.current
    setHistoryNav({ canBack: index > 0, canForward: index < stack.length - 1 })
  }, [])

  const rememberSession = useCallback(
    (path: string) => {
      const state = historyRef.current
      if (state.stack[state.index] === path) return
      state.stack = [...state.stack.slice(0, state.index + 1), path]
      if (state.stack.length > 50) state.stack = state.stack.slice(-50)
      state.index = state.stack.length - 1
      syncHistoryNav()
    },
    [syncHistoryNav]
  )

  const updateActiveUser = useCallback(() => {
    const container = scrollRef.current
    if (!container || userItems.length === 0) return
    const containerTop = container.getBoundingClientRect().top
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight
    let active = 0
    userItems.forEach((item, index) => {
      const element = container.querySelector(
        `[data-message-id="${CSS.escape(item.id)}"]`
      ) as HTMLElement | null
      if (element && element.getBoundingClientRect().top - containerTop <= 120) {
        active = index
      }
    })
    setActiveUserIndex(distance < 24 ? userItems.length - 1 : active)

    // The outline follows the same anchor rule, so the panel highlights the section in view.
    let activeEntry: string | undefined
    for (const entry of outline) {
      const element = container.querySelector(
        `[data-message-id="${CSS.escape(entry.messageId)}"]`
      ) as HTMLElement | null
      if (element && element.getBoundingClientRect().top - containerTop <= 120) {
        activeEntry = entry.id
      }
    }
    setActiveOutlineId(activeEntry)
  }, [userItems, outline])

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
      const stats = await window.pi.getSessionStats().catch(() => undefined)
      setRun({ runningTools: 0, tokens: stats?.tokens?.total })
    } catch {
      // ignore
    }
  }, [])

  const handleEvent = useCallback((record: Record<string, unknown>) => {
    const type = String(record.type ?? '')
    switch (type) {
      case 'agent_start':
        setRun({ startedAt: Date.now(), runningTools: 0 })
        break
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
        const message = record.message as
          | { role?: string; content?: unknown; customType?: string }
          | undefined
        if (message?.role === 'custom') {
          if (message.customType !== NOTICE_TYPE) break
          const text = noticeText(textFromBlocks(message.content))
          if (!text) break
          setItems((prev) => [
            ...prev,
            {
              id: `notice-${Date.now()}-${prev.length}`,
              role: 'system',
              text,
              toolCalls: []
            }
          ])
          break
        }
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
            const images = imagesFromBlocks(message.content)
            next[index] = {
              ...next[index],
              text: textFromBlocks(message.content) || next[index].text,
              images: images.length > 0 ? images : next[index].images,
              pending: false
            }
            return next
          })
        }
        break
      }
      case 'tool_execution_start': {
        setRun((prev) => ({ ...prev, runningTools: prev.runningTools + 1 }))
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
        setRun((prev) => ({ ...prev, runningTools: Math.max(0, prev.runningTools - 1) }))
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
        setRun((prev) => ({ ...prev, endedAt: Date.now(), runningTools: 0 }))
        void window.pi
          .getSessionStats()
          .then((stats) => setRun((prev) => ({ ...prev, tokens: stats.tokens?.total })))
          .catch(() => undefined)
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
    const offAsk = window.pi.onAskRequest((request) => setAskQueue((queue) => [...queue, request]))
    const offAskCleared = window.pi.onAskCleared(() => setAskQueue([]))
    return () => {
      offStatus()
      offEvent()
      offAsk()
      offAskCleared()
    }
  }, [handleEvent])

  useEffect(() => {
    void window.pi
      .listSubagents()
      .then(setSubagents)
      .catch(() => undefined)
    return window.pi.onSubagentUpdate((record) => {
      setSubagents((prev) => {
        const index = prev.findIndex((item) => item.id === record.id)
        if (index === -1) return [record, ...prev]
        const next = prev.slice()
        next[index] = record
        return next
      })
    })
  }, [])

  useEffect(() => {
    if (status.phase !== 'ready') setAskQueue([])
  }, [status.phase])

  const answerAsk = useCallback((answers: AskAnswer[]) => {
    const current = askQueueRef.current[0]
    if (!current) return
    setAskQueue((queue) => queue.filter((item) => item.id !== current.id))
    void window.pi.answerQuestion(current.id, answers)
  }, [])

  const cancelAsk = useCallback(() => {
    const current = askQueueRef.current[0]
    if (!current) return
    setAskQueue((queue) => queue.filter((item) => item.id !== current.id))
    void window.pi.cancelQuestion(current.id, '用户取消了提问')
  }, [])

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

  useEffect(() => {
    if (!run.startedAt || run.endedAt) return
    const timer = setInterval(() => setTick((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [run.startedAt, run.endedAt])

  const runStatus = run.startedAt
    ? {
        active: !run.endedAt,
        elapsedMs: Math.max(0, (run.endedAt ?? Date.now()) - run.startedAt),
        runningTools: run.runningTools,
        tokens: run.tokens
      }
    : undefined

  const openSubagents = useCallback((id?: string) => {
    setSubagentFocus(id)
    setSubagentsOpen(true)
  }, [])

  const deliver = useCallback(
    async (text: string, images: DraftImage[], behavior?: 'steer' | 'followUp'): Promise<boolean> => {
      // pi is parked on the `/btw` fork while that panel is open; nothing may go there by accident.
      if (btwChatRef.current) {
        setToast('先关闭侧边提问窗口')
        return false
      }
      setStick(true)
      const localId = `local-${Date.now()}`
      setItems((prev) => [
        ...prev,
        {
          id: localId,
          role: 'user',
          text,
          images: images.map((image) => ({ data: image.data, mimeType: image.mimeType })),
          toolCalls: [],
          pending: true
        }
      ])
      const result = await window.pi.prompt(
        text,
        behavior,
        images.map((image) => ({
          type: 'image' as const,
          data: image.data,
          mimeType: image.mimeType
        }))
      )
      if (!result.ok) {
        setItems((prev) => prev.filter((item) => item.id !== localId))
        setDraft(text)
        setDraftImages(images)
        setToast(result.error ?? '发送失败')
        return false
      }
      if (result.queued) setToast('pi 还在收尾，这条已排队，会在本轮结束后发送')
      return true
    },
    []
  )

  /** Runs a desktop slash command; returns true when the text was consumed. */

  /**
   * While a run is streaming, a new message queues instead of interrupting it. Ctrl+Enter, or the
   * send button on a queued item, forces it into the current turn with `steer`.
   */

  /**
   * Send the next queued message when a run settles.
   *
   * Deliberately depends on the run status only: adding an item must not trigger a send, otherwise
   * the second item races the first one into pi while `isStreaming` is still false.
   */
  useEffect(() => {
    // `compacting` counts as busy: pi refuses prompts while it rewrites the context.
    if (status.isStreaming || status.compacting || status.phase !== 'ready') return
    // The queue belongs to the main session: never flush it into an open `/btw` fork.
    if (btwChatRef.current) return
    const next = queueRef.current[0]
    if (!next) return
    setQueued((prev) => prev.filter((item) => item.id !== next.id))
    void deliver(next.text, next.images).then((ok) => {
      if (ok) return
      setQueued((prev) => (prev.some((item) => item.id === next.id) ? prev : [next, ...prev]))
    })
  }, [status.isStreaming, status.compacting, status.phase, deliver])

  const newSession = useCallback(async () => {
    const result = await window.pi.newSession()
    if (!result.ok) {
      setToast(result.error ?? '无法新建会话')
      return
    }
    setItems([])
    setActivePath(undefined)
    setDraft('')
    setDraftImages([])
    void loadSessions()
  }, [loadSessions])

  const runCommand = useCallback(
    async (raw: string): Promise<boolean> => {
      const text = raw.trim()
      const space = text.indexOf(' ')
      const name = (space === -1 ? text : text.slice(0, space)).toLowerCase()
      const arg = space === -1 ? '' : text.slice(space + 1).trim()
      switch (name) {
        case '/clear': {
          if (piBusy()) {
            setToast('正在回复中，先停止或等这一轮结束')
            return true
          }
          await newSession()
          setToast('已清空当前会话')
          return true
        }
        case '/compact': {
          if (piBusy()) {
            setToast('正在回复中，等这一轮结束再压缩')
            return true
          }
          setToast(arg ? `正在压缩（自定义提示词：${arg}）…` : '正在压缩上下文…')
          const result = await window.pi.compactSession(arg || undefined)
          if (!result.ok) {
            setToast(result.error ?? '压缩失败')
            return true
          }
          await loadMessages()
          setToast('上下文已压缩')
          return true
        }
        case '/autocompact': {
          if (!arg) {
            setToast('用法：/autocompact 500000（阈值 token 数）或 /autocompact off')
            return true
          }
          if (arg === 'off' || arg === 'on') {
            const result = await window.pi.setAutoCompact(arg === 'on')
            setToast(result.ok ? `自动压缩已${arg === 'on' ? '开启' : '关闭'}` : (result.error ?? '设置失败'))
            return true
          }
          const tokens = Number(arg.replace(/[^0-9]/g, ''))
          if (!Number.isFinite(tokens) || tokens <= 0) {
            setToast('阈值要写数字，例如 /autocompact 500000')
            return true
          }
          if (piBusy()) {
            setToast('正在回复中，等这一轮结束再改阈值')
            return true
          }
          const result = await window.pi.setCompactThreshold(tokens)
          setToast(
            result.ok
              ? `自动压缩阈值：${tokens} tokens（保留 ${result.reserveTokens}，窗口 ${result.contextWindow}）`
              : (result.error ?? '设置失败')
          )
          return true
        }
        case '/mcp': {
          setMcpState(await window.pi.getMcpState())
          setMcpOpen(true)
          return true
        }
        case '/btw': {
          if (!arg) {
            setToast('用法：/btw <问题>')
            return true
          }
          // A local command: it never joins the queue. If pi is still working, the fork is taken as
          // soon as it settles, and a second `/btw` replaces the old fork with a new branch.
          setBtwDraft('')
          setBtwChat({ busy: true, turns: [{ question: arg }] })
          let result: SideChatResult
          try {
            result = await window.pi.startSideChat(arg)
          } catch (cause) {
            result = { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
          }
          if (!result.ok) {
            // The branch is already discarded on the main side; leave no half-open panel behind.
            setBtwChat(undefined)
            setToast(result.error ?? '侧边提问失败')
            return true
          }
          setBtwChat({ busy: false, turns: [{ question: arg, answer: result.answer }] })
          return true
        }
        default:
          return false
      }
    },
    [loadMessages, newSession, piBusy]
  )

  const closeBtw = useCallback(async () => {
    if (!btwChatRef.current) return
    setBtwChat(undefined)
    setBtwDraft('')
    try {
      await window.pi.closeSideChat()
    } catch {
      // the branch is discarded on the main side anyway
    }
  }, [])

  const askBtw = useCallback(async () => {
    const text = btwDraft.trim()
    const current = btwChatRef.current
    if (!text || !current || current.busy) return
    setBtwDraft('')
    setBtwChat({ busy: true, turns: [...current.turns, { question: text }] })
    let result: SideChatResult
    try {
      result = await window.pi.askSideChat(text)
    } catch (cause) {
      result = { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
    }
    setBtwChat((prev) => {
      if (!prev) return prev
      const turns = [...prev.turns]
      const last = turns.length - 1
      turns[last] = {
        question: turns[last].question,
        answer: result.ok ? result.answer : undefined,
        error: result.ok ? undefined : (result.error ?? '提问失败')
      }
      return { busy: false, turns }
    })
  }, [btwDraft])

  useEffect(() => {
    if (!btwChat) return
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') void closeBtw()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [btwChat, closeBtw])
  const send = useCallback(
    async (mode: 'send' | 'steer') => {
      const text = draft.trim()
      if (!text && draftImages.length === 0) return
      // pi is parked on the `/btw` fork while that panel is open; nothing may go there by accident.
      if (btwChatRef.current) {
        setToast('先关闭侧边提问窗口')
        return
      }
      // Slash commands are local: they run here and never become a message, streaming or not.
      // Only an unknown `/xxx` falls through and goes to pi like any other prompt.
      if (text.startsWith('/') && draftImages.length === 0) {
        const handled = await runCommand(text)
        if (handled) {
          setDraft('')
          return
        }
      }
      const streaming = piBusy()
      if (streaming && mode === 'send') {
        setQueued((prev) => [
          ...prev,
          {
            id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            text,
            images: draftImages
          }
        ])
        setDraft('')
        setDraftImages([])
        return
      }
      setDraft('')
      setDraftImages([])
      await deliver(text, draftImages, streaming ? 'steer' : undefined)
    },
    [draft, draftImages, deliver, runCommand]
  )
  const selectSession = useCallback(
    async (session: SessionSummary, options: { remember?: boolean } = {}) => {
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
      if (options.remember !== false) rememberSession(session.path)
      setStick(true)
      await loadMessages()
      void loadSessions()
    },
    [activePath, loadMessages, loadSessions, rememberSession]
  )

  const goHistory = useCallback(
    (delta: number) => {
      const state = historyRef.current
      const index = state.index + delta
      if (index < 0 || index >= state.stack.length) return
      state.index = index
      syncHistoryNav()
      const path = state.stack[index]
      const session = sessionsRef.current.find((entry) => entry.path === path)
      if (session) void selectSession(session, { remember: false })
    },
    [selectSession]
  )

  const chooseWorkspace = useCallback(async () => {
    const next = await window.pi.chooseWorkspace()
    if (!next) return
    setItems([])
    setDraft('')
    setDraftImages([])
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
      setDraftImages([])
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
          canGoBack={historyNav.canBack}
          canGoForward={historyNav.canForward}
          onBack={() => goHistory(-1)}
          onForward={() => goHistory(1)}
          onNew={() => void newSession()}
          onSelect={(session) => void selectSession(session)}
          onNewInProject={(cwd) => void newSessionInProject(cwd)}
          onChooseWorkspace={() => void chooseWorkspace()}
          onOpenSettings={() => {
            setSettingsTab('providers')
            setSettingsOpen(true)
          }}
          onOpenAgentDir={() => void window.pi.openAgentDir()}
          onRestart={() => void restart()}
          onCollapse={() => setSidebarOpen(false)}
        />
      )}
      <main className="main">
        <TabBar
          title={title}
          status={status}
          streaming={Boolean(status.isStreaming || status.compacting)}
          sidebarOpen={sidebarOpen}
          subagentsRunning={subagents.filter(isSubagentRunning).length}
          subagentsFinished={
            subagents.filter((record) => !record.restored && record.status === 'idle').length
          }
          onNew={() => void newSession()}
          onToggleSidebar={() => setSidebarOpen((value) => !value)}
          onOpenSubagents={() => setSubagentsOpen(true)}
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

        <div className="main-body">
          <div className="chat-column">
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
              subagents={subagents}
              onOpenSubagent={openSubagents}
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
              outline={outline}
              activeUserIndex={activeUserIndex}
              activeOutlineId={activeOutlineId}
              onJump={jumpToMessage}
            />
          )}
        </div>

        {ask && (
          <AskQuestionPanel
            request={ask}
            queued={askQueue.length - 1}
            onSubmit={answerAsk}
            onCancel={cancelAsk}
          />
        )}

        <Composer
          value={draft}
          onChange={setDraft}
          images={draftImages}
          onImagesChange={setDraftImages}
          queued={queued}
          onQueueRemove={(id) => setQueued((prev) => prev.filter((item) => item.id !== id))}
          onQueueEdit={(id) => {
            const target = queued.find((item) => item.id === id)
            if (!target) return
            setQueued((prev) => prev.filter((item) => item.id !== id))
            setDraft(target.text)
            setDraftImages(target.images)
          }}
          onQueueSteer={(id) => {
            const target = queued.find((item) => item.id === id)
            if (!target) return
            setQueued((prev) => prev.filter((item) => item.id !== id))
            void deliver(target.text, target.images, 'steer')
          }}
          onNotice={setToast}
          onSend={(mode) => void send(mode)}
          onStop={() => void window.pi.abort()}
          streaming={Boolean(status.isStreaming || status.compacting)}
          disabled={status.phase !== 'ready' || Boolean(btwChat)}
          status={status}
          onChooseWorkspace={() => void chooseWorkspace()}
          statusBar={
            runStatus?.active || subagents.some(isSubagentRunning) ? (
              <RunStatusBar
                active={Boolean(runStatus?.active)}
                elapsedMs={runStatus?.elapsedMs ?? 0}
                tokens={runStatus?.tokens}
                runningTools={runStatus?.runningTools ?? 0}
                subagents={subagents}
                onOpenSubagent={openSubagents}
              />
            ) : undefined
          }
        />

          </div>

          {subagentsOpen && (
            <SubagentsDrawer
              records={subagents}
              initialId={subagentFocus}
              onClose={() => {
                setSubagentsOpen(false)
                setSubagentFocus(undefined)
              }}
            />
          )}
        </div>

        {btwChat && (
          <div
            className="btw-overlay"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) void closeBtw()
            }}
          >
            <div className="btw-dialog">
              <div className="btw-dialog-head">
                <span className="btw-dialog-title">侧边提问</span>
                <span className="btw-dialog-sub">
                  从当前分支节点新开一个分支，在这里可以继续追问；关闭后分支丢弃，主会话不受影响
                </span>
                <button className="icon-btn" onClick={() => void closeBtw()} title="关闭（Esc）">
                  ×
                </button>
              </div>
              <div className="btw-dialog-body">
                {btwChat.turns.map((turn, index) => (
                  <div className="btw-turn" key={`btw-${index}`}>
                    <div className="btw-q">{turn.question}</div>
                    {turn.answer !== undefined && (
                      <div className="btw-a">
                        <Markdown>{turn.answer}</Markdown>
                      </div>
                    )}
                    {turn.error && <div className="btw-error">{turn.error}</div>}
                    {btwChat.busy &&
                      index === btwChat.turns.length - 1 &&
                      turn.answer === undefined &&
                      !turn.error && <div className="btw-loading">正在回答…</div>}
                  </div>
                ))}
              </div>
              <form
                className="btw-dialog-input"
                onSubmit={(event) => {
                  event.preventDefault()
                  void askBtw()
                }}
              >
                <input
                  autoFocus
                  value={btwDraft}
                  disabled={btwChat.busy}
                  placeholder="继续追问（Enter 发送，Esc 关闭）"
                  onChange={(event) => setBtwDraft(event.target.value)}
                />
                <button
                  type="submit"
                  className="primary"
                  disabled={btwChat.busy || !btwDraft.trim()}
                >
                  发送
                </button>
              </form>
            </div>
          </div>
        )}

        {mcpOpen && (
          <div
            className="mcp-overlay"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setMcpOpen(false)
            }}
          >
            <div className="mcp-overlay-card">
              <div className="mcp-overlay-head">
                <span>MCP 服务器</span>
                <button className="icon-btn" onClick={() => setMcpOpen(false)} title="关闭">
                  ×
                </button>
              </div>
              <div className="mcp-overlay-body">
                {(mcpState?.servers ?? []).length === 0 && (
                  <div className="provider-empty">没有 MCP 服务器</div>
                )}
                {(mcpState?.servers ?? []).map((server) => (
                  <div className="mcp-overlay-row" key={server.name}>
                    <div className="mcp-overlay-main">
                      <span className="mcp-overlay-name">
                        {server.name}
                        {server.builtin && <span className="badge">内置</span>}
                        <span className="mcp-overlay-transport">{server.transport}</span>
                      </span>
                      <span className="mcp-overlay-sub">
                        {server.summary || server.description || ''}
                      </span>
                    </div>
                    <span className={`mcp-overlay-state ${server.enabled ? 'on' : ''}`}>
                      {server.enabled ? '启用' : '停用'}
                    </span>
                  </div>
                ))}
                <div className="mcp-overlay-tools">
                  {(mcpState?.desktopTools ?? []).map((tool) => (
                    <span key={tool.name} className="mcp-overlay-tool">
                      desktop:{tool.name}
                    </span>
                  ))}
                  {(mcpState?.engines ?? []).flatMap((engine) =>
                    (engine.tools ?? []).map((tool) => (
                      <span key={`${engine.id}-${tool.name}`} className="mcp-overlay-tool">
                        {engine.id}:{tool.name}
                      </span>
                    ))
                  )}
                </div>
              </div>
              <div className="mcp-overlay-foot">
                完整配置在 设置 → MCP。工具数量：桌面 {mcpState?.desktopTools.length ?? 0}
                {(mcpState?.engines ?? [])
                  .map((engine) => ` · ${engine.name} ${engine.tools?.length ?? 0}`)
                  .join('')}
              </div>
            </div>
          </div>
        )}

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
