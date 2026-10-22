export interface ToolCallView {
  id: string
  name: string
  args: string
  status: 'running' | 'done' | 'error'
  result?: string
  durationMs?: number
}

export interface ChatItem {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  thinking?: string
  toolCalls: ToolCallView[]
  streaming?: boolean
  pending?: boolean
  error?: string
  timestamp?: number
}

interface RawBlock {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  arguments?: unknown
}

interface RawMessage {
  role?: string
  content?: string | RawBlock[]
  timestamp?: number
  toolCallId?: string
  toolName?: string
  isError?: boolean
}

function blockText(block: RawBlock): string {
  if (block.type === 'text') return block.text ?? ''
  if (block.type === 'thinking') return block.thinking ?? ''
  return ''
}

function argsText(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function toChatItems(messages: RawMessage[]): ChatItem[] {
  const items: ChatItem[] = []
  const toolIndex = new Map<string, ToolCallView>()

  for (const message of messages) {
    if (message.role === 'user') {
      const text =
        typeof message.content === 'string'
          ? message.content
          : (message.content ?? []).map(blockText).filter(Boolean).join('\n')
      if (!text.trim()) continue
      items.push({
        id: `u-${message.timestamp ?? items.length}`,
        role: 'user',
        text,
        toolCalls: [],
        timestamp: message.timestamp
      })
    } else if (message.role === 'assistant') {
      const blocks = typeof message.content === 'string' ? [] : (message.content ?? [])
      const text = blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('')
      const thinking = blocks
        .filter((block) => block.type === 'thinking')
        .map((block) => block.thinking ?? '')
        .join('\n\n')
      const toolCalls: ToolCallView[] = blocks
        .filter((block) => block.type === 'toolCall')
        .map((block) => {
          const call: ToolCallView = {
            id: block.id ?? `${block.name}-${items.length}`,
            name: block.name ?? 'tool',
            args: argsText(block.arguments),
            status: 'done'
          }
          toolIndex.set(call.id, call)
          return call
        })
      if (!text && !thinking && toolCalls.length === 0) continue
      items.push({
        id: `a-${message.timestamp ?? items.length}-${items.length}`,
        role: 'assistant',
        text,
        thinking: thinking || undefined,
        toolCalls,
        timestamp: message.timestamp
      })
    } else if (message.role === 'toolResult' && message.toolCallId) {
      const call = toolIndex.get(message.toolCallId)
      const resultText =
        typeof message.content === 'string'
          ? message.content
          : (message.content ?? []).map(blockText).filter(Boolean).join('\n')
      if (call) {
        call.result = resultText
        call.status = message.isError ? 'error' : 'done'
      }
    }
  }

  return items
}

export function textFromBlocks(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const item = block as RawBlock
        if (item.type === 'text') return item.text ?? ''
        if (item.type === 'thinking') return ''
        if (item.type === 'toolCall') return ''
        return ''
      })
      .join('')
  }
  return ''
}

export function toolCallsFromBlocks(content: unknown): ToolCallView[] {
  if (!Array.isArray(content)) return []
  return content
    .map((block) => block as RawBlock)
    .filter((block) => block.type === 'toolCall')
    .map((block) => ({
      id: block.id ?? `${block.name}`,
      name: block.name ?? 'tool',
      args: argsText(block.arguments),
      status: 'done' as const
    }))
}

export function thinkingFromBlocks(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => block as RawBlock)
    .filter((block) => block.type === 'thinking')
    .map((block) => block.thinking ?? '')
    .join('\n\n')
}
