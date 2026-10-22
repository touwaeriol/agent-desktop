import { useCallback, useEffect, useState } from 'react'
import type { McpState } from '@shared/types'
import {
  CloseIcon,
  FolderIcon,
  PlusIcon,
  PlugIcon,
  RefreshIcon,
  TrashIcon
} from './Icons'

const TEMPLATE_STDIO = `{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
  "description": "本地文件系统工具"
}`

const TEMPLATE_HTTP = `{
  "url": "https://example.com/mcp",
  "headers": { "Authorization": "Bearer \${TOKEN}" },
  "description": "远程 MCP 服务"
}`

function Toggle({
  checked,
  disabled,
  onChange
}: {
  checked: boolean
  disabled?: boolean
  onChange: (value: boolean) => void
}): React.JSX.Element {
  return (
    <button
      className={`mcp-switch ${checked ? 'on' : ''}`}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  )
}

export function McpPanel({
  onNotice,
  onError
}: {
  onNotice: (message: string) => void
  onError: (message: string) => void
}): React.JSX.Element {
  const [state, setState] = useState<McpState>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [name, setName] = useState('')
  const [json, setJson] = useState(TEMPLATE_STDIO)
  const [confirmRemove, setConfirmRemove] = useState<string>()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setState(await window.pi.getMcpState())
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [onError])

  useEffect(() => {
    void load()
  }, [load])

  const run = useCallback(
    async (task: () => Promise<McpState | { ok: boolean; error?: string } | void>, message?: string) => {
      setBusy(true)
      try {
        const result = await task()
        if (result && 'ok' in result && !result.ok) {
          onError(result.error ?? '操作失败')
          return
        }
        if (message) onNotice(message)
        setState(await window.pi.getMcpState())
      } catch (cause) {
        onError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    },
    [onError, onNotice]
  )

  const remove = useCallback(
    (serverName: string) => {
      if (confirmRemove !== serverName) {
        setConfirmRemove(serverName)
        setTimeout(
          () => setConfirmRemove((value) => (value === serverName ? undefined : value)),
          4000
        )
        return
      }
      setConfirmRemove(undefined)
      void run(() => window.pi.removeMcpServer(serverName), `已删除 ${serverName}`)
    },
    [confirmRemove, run]
  )

  const submit = useCallback(() => {
    if (!name.trim()) {
      onError('请填写服务器名称')
      return
    }
    void run(() => window.pi.addMcpServer(name.trim(), json), `已添加 ${name.trim()}`).then(() => {
      setAddOpen(false)
      setName('')
      setJson(TEMPLATE_STDIO)
    })
  }, [json, name, onError, run])

  return (
    <div className="settings-content mcp">
      <div className="field">
        <label>MCP 支持</label>
        <div className="mcp-row">
          <div className="mcp-row-main">
            <span className="mcp-row-title">启用 MCP</span>
            <span className="mcp-row-sub">
              关闭后 pi 以 <code>--no-mcp</code> 启动，不连接任何 MCP 服务器。
            </span>
          </div>
          <Toggle
            checked={state?.enabled ?? true}
            disabled={busy || loading}
            onChange={(value) =>
              void run(
                () => window.pi.setMcpEnabled(value),
                value ? 'MCP 已启用' : 'MCP 已关闭'
              )
            }
          />
        </div>
        <div className="mcp-row">
          <div className="mcp-row-main">
            <span className="mcp-row-title">
              桌面交互工具 <code>ask_user_question</code>
            </span>
            <span className="mcp-row-sub">
              内置 MCP 服务器（<code>desktop</code>），让 agent 在桌面窗口弹窗提问：
              单选、多选、手动输入，多问题按顺序回答。通过 <code>--extension</code> 注入，
              不写入 mcp.json，也不影响终端里的 pi。
            </span>
            {state && !state.desktopToolAvailable && (
              <span className="mcp-row-warn">当前安装缺少扩展或服务器脚本，无法启用。</span>
            )}
            {state?.bridge.running && (
              <span className="mcp-row-meta">
                桥接已就绪 · 127.0.0.1:{state.bridge.port}
                {state.bridge.pending > 0 ? ` · 等待回答 ${state.bridge.pending}` : ''}
              </span>
            )}
          </div>
          <Toggle
            checked={state?.desktopTool ?? true}
            disabled={busy || loading || !state?.desktopToolAvailable}
            onChange={(value) =>
              void run(
                () => window.pi.setDesktopToolEnabled(value),
                value ? '桌面提问工具已启用' : '桌面提问工具已关闭'
              )
            }
          />
        </div>
      </div>

      <div className="field">
        <div className="mcp-head">
          <label>MCP 服务器</label>
          <div className="mcp-head-actions">
            <button className="ghost" onClick={() => setAddOpen((value) => !value)}>
              <PlusIcon size={12} /> 添加
            </button>
            <button
              className="ghost"
              onClick={() => void window.pi.openMcpConfig('user')}
              title={state?.userConfigPath}
            >
              <FolderIcon size={12} /> 打开 mcp.json
            </button>
            <button className="icon-btn" onClick={() => void load()} title="刷新">
              <RefreshIcon size={13} />
            </button>
          </div>
        </div>

        {addOpen && (
          <div className="mcp-add">
            <div className="mcp-add-row">
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="服务器名称（字母、数字、_、-）"
                spellCheck={false}
              />
              <button
                className="ghost"
                onClick={() => setJson(TEMPLATE_STDIO)}
                title="stdio 模板"
              >
                stdio
              </button>
              <button className="ghost" onClick={() => setJson(TEMPLATE_HTTP)} title="HTTP 模板">
                HTTP
              </button>
            </div>
            <textarea
              value={json}
              onChange={(event) => setJson(event.target.value)}
              rows={7}
              spellCheck={false}
            />
            <div className="mcp-add-actions">
              <button className="ghost" onClick={() => setAddOpen(false)}>
                取消
              </button>
              <button className="primary" onClick={submit} disabled={busy}>
                保存并重启 pi
              </button>
            </div>
          </div>
        )}

        <div className="mcp-list">
          {loading && <div className="provider-empty">正在读取 MCP 配置…</div>}
          {!loading && state?.servers.length === 0 && (
            <div className="provider-empty">
              还没有 MCP 服务器。点击「添加」或直接编辑 mcp.json。
            </div>
          )}
          {state?.servers.map((server) => (
            <div
              key={`${server.source}-${server.name}`}
              className={`mcp-server ${server.enabled ? '' : 'disabled'}`}
            >
              <span className="mcp-server-icon">
                <PlugIcon size={13} />
              </span>
              <div className="mcp-server-main">
                <div className="mcp-server-name">
                  {server.name}
                  {server.builtin && <span className="badge ok">内置</span>}
                  {server.source === 'project' && <span className="badge">项目</span>}
                  {server.exposure && <span className="badge">{server.exposure}</span>}
                </div>
                <div className="mcp-server-sub">
                  <span className="mcp-transport">{server.transport}</span>
                  <code>{server.summary}</code>
                </div>
                {server.description && (
                  <div className="mcp-server-desc">{server.description}</div>
                )}
              </div>
              <div className="mcp-server-actions">
                {server.builtin ? (
                  <span className="mcp-server-note">见上方开关</span>
                ) : (
                  <>
                    <Toggle
                      checked={server.enabled}
                      disabled={busy}
                      onChange={(value) =>
                        void run(() => window.pi.setMcpServerEnabled(server.name, value))
                      }
                    />
                    <button
                      className={`icon-btn ${confirmRemove === server.name ? 'danger' : ''}`}
                      title={confirmRemove === server.name ? '再次点击确认删除' : '删除'}
                      onClick={() => remove(server.name)}
                    >
                      {confirmRemove === server.name ? (
                        <CloseIcon size={13} />
                      ) : (
                        <TrashIcon size={13} />
                      )}
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        <p className="field-hint">
          用户级配置：<code>{state?.userConfigPath ?? '~/.pi/agent/mcp.json'}</code>
        </p>
        <p className="field-hint">
          项目级配置：<code>{state?.projectConfigPath ?? '<会话目录>/.pi/mcp.json'}</code>
          ，仅在信任该项目时生效。修改后会自动重启 pi。
        </p>
      </div>
    </div>
  )
}
