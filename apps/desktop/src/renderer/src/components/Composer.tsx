import { useEffect, useMemo, useRef, useState } from 'react'
import type { ModelOption, PiStatus } from '@shared/types'
import {
  CheckIcon,
  ChevronIcon,
  FolderIcon,
  SearchIcon,
  SendIcon,
  SparkIcon,
  StopIcon
} from './Icons'

function contextLabel(value?: number): string {
  if (!value) return ''
  if (value >= 1_000_000) {
    const millions = value / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
  }
  return `${Math.round(value / 1000)}K`
}

const THINKING_LABELS: Record<string, string> = {
  off: '关闭',
  minimal: '最少',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大'
}

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  disabled,
  status,
  onChooseWorkspace
}: {
  value: string
  onChange: (value: string) => void
  onSend: (mode: 'send' | 'queue') => void
  onStop: () => void
  streaming: boolean
  disabled: boolean
  status: PiStatus
  onChooseWorkspace: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const thinkingRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [modelOpen, setModelOpen] = useState(false)
  const [models, setModels] = useState<ModelOption[]>([])
  const [modelQuery, setModelQuery] = useState('')
  const [modelLoading, setModelLoading] = useState(false)
  const [modelError, setModelError] = useState<string>()
  const [thinkingOpen, setThinkingOpen] = useState(false)
  const [levels, setLevels] = useState<string[]>([])
  const [thinkingLoading, setThinkingLoading] = useState(false)
  const [thinkingError, setThinkingError] = useState<string>()

  useEffect(() => {
    const element = ref.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`
  }, [value])

  useEffect(() => {
    ref.current?.focus()
  }, [])

  useEffect(() => {
    if (!modelOpen) return
    const onMouseDown = (event: MouseEvent): void => {
      if (!pickerRef.current?.contains(event.target as Node)) setModelOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setModelOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [modelOpen])

  useEffect(() => {
    if (!thinkingOpen) return
    const onMouseDown = (event: MouseEvent): void => {
      if (!thinkingRef.current?.contains(event.target as Node)) setThinkingOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setThinkingOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [thinkingOpen])

  const openModelPicker = async (): Promise<void> => {
    if (modelOpen) {
      setModelOpen(false)
      return
    }
    setModelOpen(true)
    setModelQuery('')
    setModelLoading(true)
    setModelError(undefined)
    setTimeout(() => searchRef.current?.focus(), 0)
    try {
      setModels(await window.pi.listModels())
    } catch (error) {
      setModelError(error instanceof Error ? error.message : String(error))
    } finally {
      setModelLoading(false)
    }
  }

  const chooseModel = async (model: ModelOption): Promise<void> => {
    if (model.provider === status.model?.provider && model.id === status.model.id) {
      setModelOpen(false)
      return
    }
    setModelLoading(true)
    setModelError(undefined)
    const result = await window.pi.setModel(model.provider, model.id)
    setModelLoading(false)
    if (!result.ok) {
      setModelError(result.error ?? '切换模型失败')
      return
    }
    setModelOpen(false)
  }

  const groups = useMemo(() => {
    const needle = modelQuery.trim().toLowerCase()
    const map = new Map<string, ModelOption[]>()
    for (const model of models) {
      const providerName = model.providerName ?? model.provider
      const haystack = `${model.name ?? ''} ${model.id} ${providerName}`.toLowerCase()
      if (needle && !haystack.includes(needle)) continue
      const list = map.get(providerName) ?? []
      list.push(model)
      map.set(providerName, list)
    }
    return [...map.entries()]
  }, [models, modelQuery])

  const openThinkingPicker = async (): Promise<void> => {
    if (thinkingOpen) {
      setThinkingOpen(false)
      return
    }
    setThinkingOpen(true)
    setThinkingLoading(true)
    setThinkingError(undefined)
    try {
      setLevels(await window.pi.listThinkingLevels())
    } catch (error) {
      setThinkingError(error instanceof Error ? error.message : String(error))
    } finally {
      setThinkingLoading(false)
    }
  }

  const chooseThinking = async (level: string): Promise<void> => {
    if (level === status.thinkingLevel) {
      setThinkingOpen(false)
      return
    }
    setThinkingLoading(true)
    setThinkingError(undefined)
    const result = await window.pi.setThinkingLevel(level)
    setThinkingLoading(false)
    if (!result.ok) {
      setThinkingError(result.error ?? '切换思考等级失败')
      return
    }
    setThinkingOpen(false)
  }

  const workspace = status.cwd.split(/[\\/]/).filter(Boolean).pop() ?? status.cwd
  const activeLabel = status.model
    ? (models.find(
        (model) =>
          model.provider === status.model?.provider && model.id === status.model?.id
      )?.name ??
      status.model.name ??
      status.model.id)
    : '未登录 / 无可用模型'

  return (
    <div className="composer-wrap">
      <div className={`composer ${disabled ? 'disabled' : ''}`}>
        <textarea
          ref={ref}
          value={value}
          rows={1}
          spellCheck={false}
          placeholder={streaming ? '继续输入，Enter 插入当前回合，Ctrl+Enter 排到结束后' : '给 pi 发消息…'}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            if (event.nativeEvent.isComposing) return
            if (event.shiftKey) return
            event.preventDefault()
            if (event.ctrlKey || event.metaKey) {
              onSend('queue')
            } else {
              onSend('send')
            }
          }}
        />
        <div className="composer-foot">
          <div className="composer-left">
            <button
              className="chip"
              onClick={onChooseWorkspace}
              title={`${status.cwd}（切换目录并新建会话）`}
            >
              <FolderIcon size={12} />
              <span>{workspace}</span>
            </button>
            {status.sessionName && (
              <span className="chip static" title="会话名称">
                {status.sessionName}
              </span>
            )}
          </div>
          <div className="composer-right">
            <div className="model-picker-wrap" ref={pickerRef}>
              <button
                className={`chip model-chip ${status.model ? '' : 'warn'} ${modelOpen ? 'open' : ''}`}
                onClick={() => void openModelPicker()}
                title="选择模型"
              >
                <span>{activeLabel}</span>
                <ChevronIcon size={11} className="model-chevron" />
              </button>

              {modelOpen && (
                <div className="model-picker">
                  <div className="model-picker-search">
                    <SearchIcon size={13} />
                    <input
                      ref={searchRef}
                      value={modelQuery}
                      onChange={(event) => setModelQuery(event.target.value)}
                      placeholder="搜索模型或服务商"
                      spellCheck={false}
                    />
                  </div>

                  <div className="model-picker-list">
                    {modelLoading && <div className="model-picker-empty">加载模型列表…</div>}
                    {!modelLoading && groups.length === 0 && (
                      <div className="model-picker-empty">
                        {models.length === 0
                          ? '没有可用模型，请先在设置中登录服务商'
                          : '没有匹配的模型'}
                      </div>
                    )}
                    {groups.map(([providerName, list]) => (
                      <section key={providerName}>
                        <div className="model-group-label">{providerName}</div>
                        {list.map((model) => {
                          const active =
                            status.model?.provider === model.provider &&
                            status.model.id === model.id
                          return (
                            <button
                              key={`${model.provider}/${model.id}`}
                              className={`model-option ${active ? 'active' : ''}`}
                              onClick={() => void chooseModel(model)}
                            >
                              <span className="model-option-name">
                                {model.name ?? model.id}
                                {active && <CheckIcon size={12} />}
                              </span>
                              <span className="model-option-meta">
                                {model.id}
                                {model.contextWindow ? ` · ${contextLabel(model.contextWindow)}` : ''}
                              </span>
                            </button>
                          )
                        })}
                      </section>
                    ))}
                  </div>

                  {modelError && <div className="model-picker-error">{modelError}</div>}
                  <div className="model-picker-foot">
                    {models.length} 个可用模型 · 在设置中登录更多服务商
                  </div>
                </div>
              )}
            </div>

            <div className="thinking-picker-wrap" ref={thinkingRef}>
              <button
                className={`chip ${thinkingOpen ? 'open' : ''}`}
                onClick={() => void openThinkingPicker()}
                title="选择思考等级"
              >
                <SparkIcon size={12} />
                <span>{status.thinkingLevel ?? 'off'}</span>
                <ChevronIcon size={11} className="model-chevron" />
              </button>

              {thinkingOpen && (
                <div className="thinking-picker">
                  <div className="thinking-picker-head">思考等级</div>
                  {thinkingLoading && <div className="thinking-picker-empty">加载中…</div>}
                  {!thinkingLoading &&
                    levels.map((level) => {
                      const active = level === status.thinkingLevel
                      return (
                        <button
                          key={level}
                          className={`thinking-option ${active ? 'active' : ''}`}
                          onClick={() => void chooseThinking(level)}
                        >
                          <span className="thinking-option-label">
                            {THINKING_LABELS[level] ?? level}
                            <code>{level}</code>
                          </span>
                          {active && <CheckIcon size={12} />}
                        </button>
                      )
                    })}
                  {!thinkingLoading && levels.length === 0 && (
                    <div className="thinking-picker-empty">当前模型没有可用的思考等级</div>
                  )}
                  {thinkingError && <div className="thinking-picker-error">{thinkingError}</div>}
                </div>
              )}
            </div>
            {streaming ? (
              <button className="send-btn stop" onClick={onStop} title="中止当前运行">
                <StopIcon size={14} />
              </button>
            ) : (
              <button
                className="send-btn"
                onClick={() => onSend('send')}
                disabled={disabled || !value.trim()}
                title="发送 (Enter)"
              >
                <SendIcon size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="composer-hint">
        Enter 发送 · Shift+Enter 换行 · Ctrl+Enter {streaming ? '排到结束后' : '排队发送'}
      </div>
    </div>
  )
}
