import { useEffect, useState } from 'react'
import type { Project, ProjectRoot } from '@shared/types'
import { BranchIcon, CheckIcon, CloseIcon, PlusIcon, TrashIcon } from './Icons'

/**
 * Edit a project: its name, its repositories, and which one is primary.
 *
 * The primary root is pi's working directory; the others reach the model through the `<project>`
 * section, so this dialog is the only place that decides what the model is told.
 */
export function ProjectEditor({
  project,
  onClose,
  onSaved
}: {
  project: Project
  onClose: () => void
  onSaved: (project: Project) => void
}): React.JSX.Element {
  const [name, setName] = useState(project.name)
  const [roots, setRoots] = useState<ProjectRoot[]>(project.roots)
  const [busy, setBusy] = useState(false)
  /** Removing a repository is the one destructive action here, so it takes two clicks. */
  const [pendingRemove, setPendingRemove] = useState<string>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const primary = roots.find((root) => root.primary) ?? roots[0]

  const pick = async (): Promise<void> => {
    const picked = await window.pi.pickFolders(`向「${project.name}」添加目录`)
    if (picked.length === 0) return
    const known = new Set(roots.map((root) => root.path.toLowerCase()))
    const added = picked
      .filter((dir) => !known.has(dir.toLowerCase()))
      .map((dir) => ({ path: dir, name: dir.split(/[\\/]/).filter(Boolean).pop() ?? dir }))
    if (added.length === 0) {
      setError('这些目录已经在项目里了')
      return
    }
    setError(undefined)
    setRoots((current) => [...current, ...added])
  }

  const remove = (target: string): void => {
    // A project without repositories is not a project; the last one stays.
    if (roots.length <= 2) {
      setError('项目至少保留两个目录；单目录请新建会话')
      return
    }
    if (pendingRemove !== target) {
      setPendingRemove(target)
      return
    }
    setPendingRemove(undefined)
    setError(undefined)
    setRoots((current) => {
      const next = current.filter((root) => root.path !== target)
      if (!next.some((root) => root.primary) && next.length > 0) {
        return next.map((root, index) => (index === 0 ? { ...root, primary: true } : { ...root }))
      }
      return next
    })
  }

  const makePrimary = (target: string): void => {
    setRoots((current) =>
      current.map((root) =>
        root.path === target
          ? { ...root, primary: true }
          : { path: root.path, name: root.name }
      )
    )
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      const result = await window.pi.updateProject(project.id, {
        name: name.trim() || project.name,
        roots: roots.map((root) => root.path),
        primary: primary?.path
      })
      if (!result.ok || !result.project) {
        setError(result.error ?? '保存失败')
        return
      }
      onSaved(result.project)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setBusy(false) }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="project-editor" onClick={(event) => event.stopPropagation()}>
        <div className="project-editor-head">
          <span>编辑项目</span>
          <button className="icon-btn" title="关闭" onClick={onClose}>
            <CloseIcon size={13} />
          </button>
        </div>

        <div className="project-editor-body">
          <label className="field">
            <span>项目名称</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="项目名称"
              spellCheck={false}
            />
          </label>

          <div className="field">
            <span>项目目录（选中为默认工作目录）</span>
            <div className="project-editor-roots">
              {roots.map((root) => (
                <div
                  key={root.path}
                  className={`project-editor-root ${root.primary ? 'primary' : ''}`}
                  role="button"
                  tabIndex={0}
                  title={root.path}
                  onClick={() => makePrimary(root.path)}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      makePrimary(root.path)
                    }
                  }}
                >
                  <span className="project-editor-mark">
                    {root.primary ? <CheckIcon size={12} /> : <BranchIcon size={12} />}
                  </span>
                  <span className="project-editor-name">{root.name}</span>
                  <span className="project-editor-path">{root.path}</span>
                  <button
                    className={`project-editor-remove ${pendingRemove === root.path ? 'confirm' : ''}`}
                    title={pendingRemove === root.path ? '再点一次移除' : '从项目里移除'}
                    onClick={(event) => {
                      event.stopPropagation()
                      remove(root.path)
                    }}
                  >
                    {pendingRemove === root.path ? <span>再点一次</span> : <TrashIcon size={12} />}
                  </button>
                </div>
              ))}
            </div>
            <button className="project-editor-add" onClick={() => void pick()}>
              <PlusIcon size={12} />
              <span>添加目录…</span>
            </button>
            <p className="field-hint">
              项目内的会话可同时访问这些目录。只需一个目录时，直接新建会话即可。
            </p>
          </div>

          {error && <div className="project-editor-error">{error}</div>}
        </div>

        <div className="project-editor-foot">
          <button className="project-editor-cancel" onClick={onClose}>
            取消
          </button>
          <button className="project-editor-save" disabled={busy} onClick={() => void save()}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
