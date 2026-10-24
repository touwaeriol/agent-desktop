import type { AgentMessage, ContentBlock } from '../../shared/types'

// Read compatibility for previously imported sessions only. Live model switches use pi SDK's
// adapters on a cloned transcript, never this lossy legacy normalization.

export type HistoryMessage = AgentMessage & { role: 'user' | 'assistant' | 'toolResult' }

function toolArguments(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { return toolArguments(JSON.parse(value)) } catch { return { raw: value } }
  }
  if (value && typeof value === 'object' && !Array.isArray(value))
    return structuredClone(value) as Record<string, unknown>
  return value == null ? {} : { value: structuredClone(value) }
}

function blocks(content: unknown, tools = false): ContentBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  return content.flatMap((block): ContentBlock[] => {
    if (!block || typeof block !== 'object') return []
    if (block.type === 'text' && typeof block.text === 'string') return [{ type: 'text', text: block.text }]
    if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string')
      return [{ type: 'image', data: block.data, mimeType: block.mimeType }]
    if (block.type === 'image' && block.source?.type === 'base64' &&
      typeof block.source.data === 'string' && typeof block.source.media_type === 'string')
      return [{ type: 'image', data: block.source.data, mimeType: block.source.media_type }]
    if (tools && block.type === 'toolCall' && typeof block.name === 'string')
      return [{ type: 'toolCall', id: String(block.id ?? ''), name: block.name,
        arguments: toolArguments(block.arguments) }]
    // Reasoning, encrypted content and provider signatures never cross engine boundaries.
    return []
  })
}

/** Portable context only: no permissions, system instructions, provider state or reasoning. */
export function normalizeHistory(input: unknown[]): HistoryMessage[] {
  const out: HistoryMessage[] = []
  const pending = new Map<string, { id: string; name: string }>()
  let sequence = 0
  const finishPending = (): void => {
    for (const tool of pending.values()) out.push({ role: 'toolResult', toolCallId: tool.id,
      toolName: tool.name, isError: true, content: [{ type: 'text',
        text: '旧历史中缺少此工具的结果；执行状态未知，请先检查实际状态，不要假定成功。' }] })
    pending.clear()
  }
  for (const value of input) {
    if (!value || typeof value !== 'object') continue
    const raw = value as Record<string, unknown>
    if (raw.role === 'compactionSummary' || raw.role === 'branchSummary') {
      finishPending()
      if (typeof raw.summary === 'string') out.push({ role: 'user', content: [{ type: 'text', text: '此前上下文摘要：\n' + raw.summary }] })
      continue
    }
    if (!['user', 'assistant', 'toolResult'].includes(String(raw.role))) continue
    const content = blocks(raw.content, raw.role === 'assistant')
    if (raw.role === 'toolResult') {
      const key = String(raw.toolCallId ?? '')
      const tool = pending.get(key)
      if (tool) {
        out.push({ role: 'toolResult', toolCallId: tool.id, toolName: tool.name,
          isError: Boolean(raw.isError), content: content.length ? content : [{ type: 'text', text: '(无输出)' }] })
        pending.delete(key)
      } else {
        finishPending()
        out.push({ role: 'user', content: [{ type: 'text', text: '历史工具结果（原调用记录缺失）：' + String(raw.toolName ?? 'tool') }, ...content] })
      }
      continue
    }
    if (!content.length) continue
    finishPending()
    for (const block of content) {
      if (block.type !== 'toolCall') continue
      const original = block.id ?? ''
      if (pending.has(original)) throw new Error('历史中同一回合出现重复工具调用 ID，无法可靠迁移')
      block.id = 'call_import_' + (++sequence)
      pending.set(original, { id: block.id, name: block.name! })
    }
    out.push({ role: raw.role as 'user' | 'assistant', content,
      ...(typeof raw.timestamp === 'number' && Number.isFinite(raw.timestamp) ? { timestamp: raw.timestamp } : {}) })
  }
  finishPending()
  return out
}

/** Codex model-visible imports may not be projected into thread.turns by the native server. */
export function mergeImportedHistory(prefix: HistoryMessage[], native: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  if (!prefix.length) return native
  const comparable = (messages: HistoryMessage[]) => messages.map(({ timestamp: _time, ...m }) => m)
  const visible = comparable(normalizeHistory(native))
  const imported = comparable(normalizeHistory(prefix))
  const alreadyVisible = JSON.stringify(visible.slice(0, imported.length)) === JSON.stringify(imported)
  return alreadyVisible ? native : [...structuredClone(prefix).map((message) => ({ ...message })), ...native]
}
