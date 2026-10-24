import { useEffect } from 'react'

export interface ConfirmRequest {
  title: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Destructive choices read better in red; a session switch that kills a turn is one. */
  danger?: boolean
}

/**
 * A small modal for decisions that must be answered before an action runs.
 *
 * It is not a replacement for the question panel (that one belongs to the agent): this is the
 * window asking the user about its own next step, e.g. switching sessions would stop the run.
 */
export function ConfirmDialog({
  request,
  onResolve
}: {
  request: ConfirmRequest
  onResolve: (confirmed: boolean) => void
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onResolve(false)
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        onResolve(true)
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onResolve])

  return (
    <div className="modal-backdrop" onMouseDown={() => onResolve(false)}>
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={request.title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <strong className="confirm-title">{request.title}</strong>
        {request.message && <p className="confirm-message">{request.message}</p>}
        <div className="confirm-actions">
          <button className="ghost" onClick={() => onResolve(false)}>
            {request.cancelLabel ?? '取消'}
          </button>
          <button
            className={request.danger ? 'danger' : 'primary'}
            onClick={() => onResolve(true)}
            autoFocus
          >
            {request.confirmLabel ?? '确定'}
          </button>
        </div>
      </div>
    </div>
  )
}
