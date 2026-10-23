/** One decoder per child process: framing is shared, protocol semantics stay with the caller. */
export function createJsonLineDecoder(
  consume: (record: Record<string, unknown>) => void
): (chunk: string) => void {
  let buffer = ''
  return (chunk) => {
    buffer += chunk
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      let record: unknown
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (record && typeof record === 'object' && !Array.isArray(record)) {
        consume(record as Record<string, unknown>)
      }
    }
  }
}
