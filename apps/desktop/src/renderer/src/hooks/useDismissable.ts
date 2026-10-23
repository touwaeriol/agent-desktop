import { useEffect, useRef, type RefObject } from 'react'

/** Close a floating panel on Escape or a click outside its owning element. */
export function useDismissable(
  open: boolean,
  boundary: RefObject<HTMLElement | null>,
  dismiss: () => void
): void {
  const dismissRef = useRef(dismiss)
  useEffect(() => {
    dismissRef.current = dismiss
  }, [dismiss])
  useEffect(() => {
    if (!open) return
    const onMouseDown = (event: MouseEvent): void => {
      if (!boundary.current?.contains(event.target as Node)) dismissRef.current()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') dismissRef.current()
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, boundary])
}
