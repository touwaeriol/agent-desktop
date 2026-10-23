import {
  imagesFromBlocks,
  NOTICE_TYPE,
  noticeText,
  textFromBlocks,
  thinkingFromBlocks,
  toolCallsFromBlocks,
  type ChatItem,
  type ToolCallView
} from './messages'

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


function patchPendingUser(items: ChatItem[], content?: unknown): ChatItem[] {
  const index = items.findLastIndex((item) => item.role === 'user' && item.pending)
  if (index < 0) return items
  const images = imagesFromBlocks(content)
  const next = items.slice()
  next[index] = {
    ...next[index],
    text: textFromBlocks(content) || next[index].text,
    images: images.length > 0 ? images : next[index].images,
    pending: false
  }
  return next
}

function finishMessage(items: ChatItem[], message: MessagePayload, now: number): ChatItem[] {
  if (message.role === 'user') return patchPendingUser(items, message.content)
  if (message.role === 'custom') {
    if (message.customType !== NOTICE_TYPE) return items
    const text = noticeText(textFromBlocks(message.content))
    return text ? [...items, { id: 'notice-' + now + '-' + items.length, role: 'system', text, toolCalls: [] }] : items
  }
  if (message.role !== 'assistant') return items
  return patchLastAssistant(items, (item) => {
    const calls = toolCallsFromBlocks(message.content)
    return {
      ...item,
      text: textFromBlocks(message.content) || item.text,
      thinking: thinkingFromBlocks(message.content) || item.thinking,
      toolCalls: calls.length > 0 ? calls.map((call) => {
        const existing = item.toolCalls.find((entry) => entry.id === call.id)
        return existing ? mergeCall(call, existing) : call
      }) : item.toolCalls,
      streaming: false
    }
  })
}

interface MessagePayload {
  role?: string
  content?: unknown
  customType?: string
}

/** Pure event projection: IPC and run timing stay in App; chat transformations stay here. */
export function applyConversationEvent(items: ChatItem[], record: Record<string, unknown>, now: number): ChatItem[] {
  switch (record.type) {
    case 'message_start': {
      const message = record.message as MessagePayload | undefined
      if (message?.role === 'user') return patchPendingUser(items)
      if (message?.role !== 'assistant') return items
      return [...items, { id: 'assistant-' + now + '-' + items.length, role: 'assistant', text: '', thinking: '', toolCalls: [], streaming: true }]
    }
    case 'message_update': {
      const event = record.assistantMessageEvent as { type?: string; delta?: string; toolCall?: ToolCallPayload } | undefined
      if (event?.type === 'text_delta') return appendDelta(items, 'text', event.delta ?? '')
      if (event?.type === 'thinking_delta') return appendDelta(items, 'thinking', event.delta ?? '')
      if (event?.type === 'toolcall_end' && event.toolCall) return upsertTool(items, partialToolCall(event.toolCall, { status: 'running' }))
      return items
    }
    case 'message_end':
      return finishMessage(items, (record.message as MessagePayload | undefined) ?? {}, now)
    case 'tool_execution_start':
      return upsertTool(items, partialToolCall(record, { status: 'running' }))
    case 'tool_execution_update':
      return upsertTool(items, partialToolCall(record, { status: 'running', result: resultText(record.partialResult) }))
    case 'tool_execution_end':
      return upsertTool(items, partialToolCall(record, {
        status: record.isError ? 'error' : 'done',
        result: resultText(record.result),
        durationMs: typeof record.durationMs === 'number' ? record.durationMs : undefined
      }))
    case 'agent_settled':
      return items.map((item) => item.streaming ? { ...item, streaming: false } : item)
    default:
      return items
  }
}
