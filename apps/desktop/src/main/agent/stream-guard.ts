/** Bound inactivity, while allowing a long stream to keep making progress. */
export async function* guardedStream<T>(
  source: (signal: AbortSignal) => AsyncIterable<T>,
  parent: AbortSignal | undefined,
  timeoutMs: number
): AsyncGenerator<T> {
  const controller = new AbortController()
  const abort = () => controller.abort(parent?.reason)
  if (parent?.aborted) abort()
  parent?.addEventListener('abort', abort, { once: true })
  const iterator = source(controller.signal)[Symbol.asyncIterator]()
  try {
    for (;;) {
      controller.signal.throwIfAborted()
      let timer: ReturnType<typeof setTimeout> | undefined
      let cancel: (() => void) | undefined
      try {
        const result = await Promise.race([
          iterator.next(),
          new Promise<never>((_resolve, reject) => {
            cancel = () => reject(controller.signal.reason ?? new Error('已停止'))
            controller.signal.addEventListener('abort', cancel, { once: true })
            timer = setTimeout(() => controller.abort(new Error(`模型响应 timeout：连续 ${Math.round(timeoutMs / 1000)} 秒没有新数据`)), timeoutMs)
          })
        ])
        if (result.done) return
        yield result.value
      } finally {
        clearTimeout(timer)
        if (cancel) controller.signal.removeEventListener('abort', cancel)
      }
    }
  } finally {
    parent?.removeEventListener('abort', abort)
    controller.abort()
    void iterator.return?.().catch(() => undefined)
  }
}
