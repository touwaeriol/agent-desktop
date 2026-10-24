/** Empty session files do not lock setup; real history does, including restored history. */
export function conversationHasStarted(messages: unknown[]): boolean {
  return messages.some(value => {
    if (!value || typeof value !== 'object') return false
    const message = value as { role?: string; customType?: string; content?: unknown }
    if (message.customType || !['user', 'assistant', 'toolResult'].includes(message.role ?? '')) return false
    if (typeof message.content === 'string') return !!message.content.trim()
    return Array.isArray(message.content) && message.content.some(block =>
      block && (block.type === 'image' || block.type === 'toolCall' || (block.type === 'text' && block.text?.trim())))
  })
}
