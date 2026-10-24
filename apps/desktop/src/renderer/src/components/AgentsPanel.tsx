import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AgentPresetDraft, McpState, SubagentPresetInfo } from '@shared/types'
import { CheckIcon, CloseIcon, PencilIcon, PlusIcon, TrashIcon } from './Icons'
import { Toggle } from './Toggle'
import { runAction } from '../lib/actions'

const TOOL_OPTIONS = ['read', 'write', 'edit', 'bash', 'powershell', 'grep', 'find', 'ls']

const MODE_LABEL: Record<string, string> = {
  sync: '同步等待',
  background: '后台运行'
}

interface Draft extends AgentPresetDraft {
  key: string
}

function toDraft(preset?: SubagentPresetInfo): Draft {
  return {
    key: preset?.id ?? `new-${Date.now()}`,
    id: preset?.id ?? '',
    name: preset?.name ?? '',
    description: preset?.description ?? '',
    mode: preset?.mode ?? 'background',
    tools: preset ? (preset.tools ?? null) : ['read', 'grep', 'find', 'ls'],
    model: preset?.model ?? 'inherit',
    appendSystemPrompt: preset?.appendSystemPrompt ?? '',
    visible: preset?.visible !== false,
    timeoutMs: preset?.timeoutMs
  }
}

function abilityLabel(preset: SubagentPresetInfo): string {
  if (!preset.tools || preset.tools.length === 0) return '全量工具'
  const writable = preset.tools.some((tool) => ['edit', 'write', 'bash', 'powershell'].includes(tool))
  return writable ? '可写' : '只读'
}

export function AgentsPanel({
  onNotice,
  onError
}: {
  onNotice: (message: string) => void
  onError: (message: string) => void
}): React.JSX.Element {
  const [state, setState] = useState<McpState>()
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<Draft>()
  const [modelProvider, setModelProvider] = useState('')
  const [modelId, setModelId] = useState('')

  const load = useCallback(async () => {
    try {
      setState(await window.pi.getMcpState())
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    }
  }, [onError])

  useEffect(() => {
    void load()
    return window.pi.onMcpState((next) => setState(next))
  }, [load])

  const subagents = state?.subagents
  const presets = useMemo(() => subagents?.presets ?? [], [subagents])

  const run = useCallback(
    async (task: () => Promise<{ ok: boolean; error?: string; state?: McpState }>, message: string) => {
      return runAction(task, {
        setBusy,
        onError,
        onSuccess: (result) => {
          if (result.state) setState(result.state)
          onNotice(message)
        }
      })
    },
    [onError, onNotice]
  )

  const openEditor = (preset?: SubagentPresetInfo): void => {
    const next = toDraft(preset)
    setDraft(next)
    const model = preset?.model
    setModelProvider(model && model !== 'inherit' ? model.provider : '')
    setModelId(model && model !== 'inherit' ? model.id : '')
  }

  const save = (): void => {
    if (!draft) return
    const model =
      modelProvider.trim() && modelId.trim()
        ? { provider: modelProvider.trim(), id: modelId.trim() }
        : 'inherit'
    void run(
      () =>
        window.pi.saveAgentPreset({
          id: draft.id,
          name: draft.name,
          description: draft.description,
          mode: draft.mode,
          tools: draft.tools,
          model,
          appendSystemPrompt: draft.appendSystemPrompt,
          visible: draft.visible,
          timeoutMs: draft.timeoutMs
        }),
      '预设已保存'
    ).then((ok) => {
      if (ok) setDraft(undefined)
    })
  }

  if (!subagents) {
    return <div className="settings-content agents"><div className="provider-empty">正在读取子代理配置…</div></div>
  }

  return (
    <div className="settings-content agents">
      <div className="field">
        <label>子代理</label>
        <div className={`mcp-engine ${subagents.enabled ? '' : 'disabled'}`}>
          <div className="mcp-row">
            <div className="mcp-row-main">
              <span className="mcp-row-title">
                子代理
                <span className="mcp-version">
                  {presets.length} 个预设
                  {subagents.running > 0 ? ` · ${subagents.running} 个在跑` : ''}
                </span>
              </span>
              <span className="mcp-row-sub">
                子代理跟随当前引擎：内建 agent 使用独立执行循环，pi 使用独立进程。预设配置工具白名单与提示词，
                调用时还能逐个覆盖。
              </span>
            </div>
            <Toggle
              checked={subagents.enabled}
              disabled={busy}
              onChange={(value) =>
                void window.pi.setSubagentsEnabled(value).then((next) => {
                  setState(next)
                  onNotice(value ? '子代理已启用' : '子代理已关闭')
                })
              }
            />
          </div>

          {subagents.enabled && (
            <div className="mcp-engine-actions">
              <span className="mcp-row-meta">预设如何暴露给模型：</span>
              {(
                [
                  ['prompt', '写进系统提示词'],
                  ['lazy', '按需搜索'],
                  ['hidden', '不提示']
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  className={`ghost ${subagents.exposure === value ? 'active' : ''}`}
                  disabled={busy}
                  onClick={() =>
                    void window.pi.setAgentExposure(value).then((next) => {
                      setState(next)
                      onNotice(`暴露方式：${label}`)
                    })
                  }
                >
                  {label}
                </button>
              ))}
              <button className="ghost" disabled={busy} onClick={() => void window.pi.openAgentsConfig()}>
                打开 agents.json
              </button>
            </div>
          )}
        </div>
        <p className="field-hint">以上预设供内建 agent 和 pi 使用；Claude Code、Codex 使用各自原生子代理。内建子代理的思考等级按模型能力校验；暂不接入桌面 MCP，运行中可打断后重发。</p>
      </div>

      <div className="field">
        <div className="mcp-head">
          <label>预设</label>
          <div className="mcp-head-actions">
            <button className="ghost" disabled={busy} onClick={() => openEditor()}>
              <PlusIcon size={12} /> 新建
            </button>
          </div>
        </div>
        <div className="agent-list">
          {presets.map((preset) => (
            <div className="agent-row" key={preset.id}>
              <div className="agent-main">
                <span className="agent-title">
                  <code>{preset.id}</code>
                  <span className="agent-name">{preset.name}</span>
                  {preset.source === 'user' && <span className="badge">自定义</span>}
                </span>
                <span className="agent-meta">
                  {MODE_LABEL[preset.mode ?? 'background']} · {abilityLabel(preset)}
                  {preset.model && preset.model !== 'inherit'
                    ? ` · ${preset.model.provider}/${preset.model.id}`
                    : ' · 继承主会话模型'}
                  {preset.tools?.length ? ` · ${preset.tools.join(', ')}` : ''}
                </span>
                {preset.description && <span className="agent-desc">{preset.description}</span>}
              </div>
              <div className="agent-actions">
                <button className="ghost" disabled={busy} onClick={() => openEditor(preset)} title="编辑">
                  <PencilIcon size={12} />
                </button>
                {preset.source === 'user' && (
                  <button
                    className="ghost"
                    disabled={busy}
                    title="删除（内置预设会恢复默认）"
                    onClick={() =>
                      void run(() => window.pi.deleteAgentPreset(preset.id), `已删除 ${preset.id}`)
                    }
                  >
                    <TrashIcon size={12} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {draft && (
        <div className="field agent-editor">
          <div className="mcp-head">
            <label>{presets.some((preset) => preset.id === draft.id) ? `编辑 ${draft.id}` : '新建预设'}</label>
            <div className="mcp-head-actions">
              <button className="ghost" onClick={() => setDraft(undefined)}>
                <CloseIcon size={12} /> 取消
              </button>
            </div>
          </div>

          <div className="field-grid">
            <div className="field">
              <label>id</label>
              <input
                value={draft.id}
                onChange={(event) => setDraft({ ...draft, id: event.target.value })}
                placeholder="explorer"
                spellCheck={false}
              />
            </div>
            <div className="field">
              <label>名称</label>
              <input
                value={draft.name ?? ''}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder="代码探查"
              />
            </div>
          </div>

          <div className="field">
            <label>说明（模型靠它判断何时用）</label>
            <input
              value={draft.description ?? ''}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              placeholder="只读定位实现，返回 file:line"
            />
          </div>

          <div className="field">
            <label>启动方式</label>
            <div className="agent-mode">
              {(['background', 'sync'] as const).map((mode) => (
                <button
                  key={mode}
                  className={`ghost ${draft.mode === mode ? 'active' : ''}`}
                  onClick={() => setDraft({ ...draft, mode })}
                >
                  {MODE_LABEL[mode]}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label>工具（传给 pi 的 --tools 白名单）</label>
            <div className="agent-tools">
              <button
                className={`ghost ${draft.tools === null ? 'active' : ''}`}
                onClick={() => setDraft({ ...draft, tools: null })}
              >
                全量工具
              </button>
              {TOOL_OPTIONS.map((tool) => {
                const checked = Array.isArray(draft.tools) && draft.tools.includes(tool)
                return (
                  <button
                    key={tool}
                    className={`ghost ${checked ? 'active' : ''}`}
                    onClick={() => {
                      const current = Array.isArray(draft.tools) ? draft.tools : []
                      const next = checked
                        ? current.filter((entry) => entry !== tool)
                        : [...current, tool]
                      setDraft({ ...draft, tools: next })
                    }}
                  >
                    {checked && <CheckIcon size={11} />}
                    <code>{tool}</code>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="field">
            <label>模型（留空继承主会话）</label>
            <div className="agent-model">
              <input
                value={modelProvider}
                onChange={(event) => setModelProvider(event.target.value)}
                placeholder="provider，如 deepseek"
                spellCheck={false}
              />
              <input
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
                placeholder="model，如 deepseek-flash"
                spellCheck={false}
              />
            </div>
          </div>

          <div className="field">
            <label>追加系统提示词（--append-system-prompt）</label>
            <textarea
              value={draft.appendSystemPrompt ?? ''}
              onChange={(event) => setDraft({ ...draft, appendSystemPrompt: event.target.value })}
              rows={4}
              spellCheck={false}
              placeholder="You are read-only: search and read, never edit."
            />
          </div>

          <div className="agent-editor-actions">
            <button className="primary" disabled={busy || !draft.id.trim()} onClick={save}>
              保存并重启 pi
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
