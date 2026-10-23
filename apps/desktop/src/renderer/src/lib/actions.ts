/** A settings mutation succeeds only when the transport and the returned result both succeed. */
export async function runAction<T>(task: () => Promise<T>, handlers: {
  setBusy: (busy: boolean) => void
  onError: (message: string) => void
  onSuccess: (result: T) => void | Promise<void>
}): Promise<boolean> {
  handlers.setBusy(true)
  try {
    const result = await task()
    if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
      const error = 'error' in result ? result.error : undefined
      handlers.onError(typeof error === 'string' ? error : '操作失败')
      return false
    }
    await handlers.onSuccess(result)
    return true
  } catch (error) {
    handlers.onError(error instanceof Error ? error.message : String(error))
    return false
  } finally {
    handlers.setBusy(false)
  }
}
