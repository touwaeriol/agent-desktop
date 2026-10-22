import type { ChatItem } from './messages'

export interface OutlineEntry {
  id: string
  messageId: string
  level: number
  title: string
  kind: 'start' | 'heading' | 'fallback'
}

function cleanInline(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function headings(text: string): { level: number; title: string }[] {
  const result: { level: number; title: string }[] = []
  let fenced = false
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (!match) continue
    const title = cleanInline(match[2])
    if (title) result.push({ level: match[1].length, title })
  }
  return result
}

export function buildOutline(items: ChatItem[]): OutlineEntry[] {
  const entries: OutlineEntry[] = []
  const firstUser = items.find((item) => item.role === 'user')
  if (firstUser) {
    entries.push({
      id: 'outline-start',
      messageId: firstUser.id,
      level: 0,
      title: '会话开始',
      kind: 'start'
    })
  }

  for (const item of items) {
    if (item.role !== 'assistant' || !item.text.trim()) continue
    const found = headings(item.text)
    if (found.length > 0) {
      found.forEach((heading, index) => {
        entries.push({
          id: `${item.id}-h${index}`,
          messageId: item.id,
          level: heading.level,
          title: heading.title,
          kind: 'heading'
        })
      })
      continue
    }
    const firstLine = item.text
      .split('\n')
      .map((line) => cleanInline(line))
      .find(Boolean)
    if (!firstLine) continue
    entries.push({
      id: `${item.id}-t`,
      messageId: item.id,
      level: 2,
      title: firstLine.length > 90 ? `${firstLine.slice(0, 90)}…` : firstLine,
      kind: 'fallback'
    })
  }

  return entries.filter(
    (entry, index) => index === 0 || entry.title !== entries[index - 1].title
  )
}
