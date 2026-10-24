export function directoryKey(value: string): string {
  const windows = /^[A-Za-z]:/.test(value) || value.includes('\\')
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
  return windows ? normalized.toLowerCase() : normalized
}

/** Most recent first; keep the readable original path, not a lower-cased display string. */
export function recentDirectories(values: string[], limit = 24): string[] {
  const seen = new Set<string>()
  return values.filter(value => {
    if (typeof value !== 'string' || !value.trim()) return false
    const key = directoryKey(value)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, limit)
}
