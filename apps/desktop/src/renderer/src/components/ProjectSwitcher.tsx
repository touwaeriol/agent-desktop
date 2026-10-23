import { useEffect, useRef, useState } from 'react'
import type { Project } from '@shared/types'
import { PencilIcon, PlusIcon, TrashIcon } from './Icons'

const DELETE_CONFIRM_MS = 4000

/** `3 个仓库` / `1 个仓库` — the chip subtitle. */
export function rootCountLabel(count: number): string {
  return `${count} 个仓库`
}

function chipTitle(project: Project): string {
  const paths = project.roots.map((root) => root.path).filter(Boolean)
  return paths.length > 0 ? [project.name, ...paths].join('\n') : project.name
}

export function ProjectSwitcher({
  projects,
  activeId,
  onSelect,
  onCreate,
  onEdit,
  onDelete
}: {
  projects: Project[]
  activeId?: string
  onSelect: (id: string) => void
  onCreate: () => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
}): React.JSX.Element {
  const [pendingDelete, setPendingDelete] = useState<string>()
  const confirmTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    return () => {
      if (confirmTimer.current !== undefined) window.clearTimeout(confirmTimer.current)
    }
  }, [])

  // Two-step delete: there is no dialog component to lean on, so the first click arms the chip and
  // the second one within DELETE_CONFIRM_MS actually deletes.
  const requestDelete = (id: string): void => {
    if (confirmTimer.current !== undefined) window.clearTimeout(confirmTimer.current)
    if (pendingDelete !== id) {
      setPendingDelete(id)
      confirmTimer.current = window.setTimeout(() => {
        // Another chip may have armed meanwhile; only drop our own flag.
        setPendingDelete((current) => (current === id ? undefined : current))
        confirmTimer.current = undefined
      }, DELETE_CONFIRM_MS)
      return
    }
    confirmTimer.current = undefined
    setPendingDelete(undefined)
    onDelete(id)
  }

  if (projects.length === 0) {
    return (
      <div className="project-switcher">
        <div className="project-switcher-empty">
          <button className="project-switcher-create" title="新建项目" onClick={onCreate}>
            <PlusIcon size={13} />
            <span>新建项目</span>
          </button>
          <div className="project-switcher-hint">项目可以把多个仓库放在一起工作</div>
        </div>
      </div>
    )
  }

  return (
    <div className="project-switcher">
      {projects.map((project) => {
        const confirming = pendingDelete === project.id
        return (
          <div
            key={project.id}
            className={`project-chip ${project.id === activeId ? 'active' : ''}`}
            role="button"
            tabIndex={0}
            title={chipTitle(project)}
            onClick={() => onSelect(project.id)}
            onKeyDown={(event) => {
              // Keys pressed on the nested edit/delete buttons must not reach the chip itself.
              if (event.target !== event.currentTarget) return
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onSelect(project.id)
              }
              if (event.key === 'Delete') {
                event.preventDefault()
                requestDelete(project.id)
              }
            }}
          >
            <span className="project-chip-name">{project.name}</span>
            <span className="project-chip-sep">·</span>
            <span className="project-chip-count">{rootCountLabel(project.roots.length)}</span>
            <span className="project-chip-actions">
              <button
                className="project-chip-action"
                title={`编辑项目 ${project.name}`}
                onClick={(event) => {
                  event.stopPropagation()
                  onEdit(project.id)
                }}
              >
                <PencilIcon size={11} />
              </button>
              <button
                className={`project-chip-action danger ${confirming ? 'confirm' : ''}`}
                title={confirming ? '再点一次删除' : `删除项目 ${project.name}`}
                onClick={(event) => {
                  event.stopPropagation()
                  requestDelete(project.id)
                }}
              >
                {confirming ? <span>再点一次删除</span> : <TrashIcon size={11} />}
              </button>
            </span>
          </div>
        )
      })}
      <button className="project-chip-add" title="新建项目" onClick={onCreate}>
        <PlusIcon size={13} />
      </button>
    </div>
  )
}
