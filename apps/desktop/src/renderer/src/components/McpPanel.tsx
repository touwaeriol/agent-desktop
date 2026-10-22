import { useCallback, useEffect, useState } from 'react'
import type {
  McpEngineId,
  McpEngineState,
  McpState,
  McpToolInfo,
  McpWebState,
  WebSearchMode
} from '@shared/types'
import {
  ChevronIcon,
  CloseIcon,
  FolderIcon,
  PlusIcon,
  PlugIcon,
  RefreshIcon,
  TrashIcon
} from './Icons'
import { Toggle } from './Toggle'

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

const INSTALL_HINTS: Record<McpEngineId, string> = {
  codegraph: 'npm i -g @colbymchenry/codegraph',
  warpgrep: '在 Morph 控制台创建 API Key 后粘贴到下方',
  web: '在 Brave Search API 控制台创建订阅令牌后粘贴到下方'
}

const ENGINE_LABELS: Record<string, string> = {
  codegraph: 'CodeGraph',
  warpgrep: 'WarpGrep',
  web: '网络搜索'
}

function ToolSection({
  server,
  tools,
  busy,
  open,
  onOpenChange,
  onToggle
}: {
  server: string
  tools: McpToolInfo[]
  busy: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onToggle: (server: string, tool: string, enabled: boolean) => void
}): React.JSX.Element {
  const direct = tools.filter((tool) => tool.enabled && (tool.direct || tool.exposure === 'direct')).length
  const off = tools.filter((tool) => !tool.enabled).length
  return (
    <div className="mcp-tools-block">
      <button
        className={`mcp-tools-head ${open ? 'open' : ''}`}
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
      >
        <ChevronIcon size={11} />
        <span>工具</span>
        {tools.length > 0 ? (
          <span className="mcp-tools-count">
            {tools.length} 个 · {direct} 直接声明
            {off > 0 ? ` · ${off} 已关闭` : ''}
          </span>
        ) : (
          <span className="mcp-tools-count">连接后自动发现</span>
        )}
      </button>
      {open &&
        (tools.length === 0 ? (
          <div className="mcp-tools-empty">
            工具列表会在服务器首次连接后自动发现；也可以先发一条消息再回来查看。
          </div>
        ) : (
          <div className="mcp-tools">
            {tools.map((tool) => {
              const isDirect = tool.direct === true || tool.exposure === 'direct'
              return (
                <label
                  key={`${server}-${tool.name}`}
                  className={`mcp-tool ${tool.enabled ? '' : 'off'}`}
                >
                  <Toggle
                    checked={tool.enabled}
                    disabled={busy}
                    onChange={(value) => onToggle(server, tool.name, value)}
                  />
                  <code>{tool.name}</code>
                  <span className={`badge ${tool.enabled && isDirect ? 'ok' : ''}`}>
                    {tool.enabled ? (isDirect ? '直接声明' : '按需加载') : '已关闭'}
                  </span>
                </label>
              )
            })}
          </div>
        ))}
    </div>
  )
}

function EngineCard({
  engine,
  busy,
  morphKeyHint,
  web,
  toolsOpen,
  onToolsOpenChange,
  onToggle,
  onPickEntry,
  onClearEntry,
  onBuildIndex,
  onSaveKey,
  onSaveBraveKey,
  onSetWebMode,
  onToggleTool
}: {
  engine: McpEngineState
  busy: boolean
  morphKeyHint?: string
  web?: McpWebState
  toolsOpen: boolean
  onToolsOpenChange: (open: boolean) => void
  onToggle: (id: McpEngineId, enabled: boolean) => void
  onPickEntry: (id: McpEngineId) => void
  onClearEntry: (id: McpEngineId) => void
  onBuildIndex: () => void
  onSaveKey: (key: string | null) => void
  onSaveBraveKey: (key: string | null) => void
  onSetWebMode: (mode: WebSearchMode) => void
  onToggleTool: (server: string, tool: string, enabled: boolean) => void
}): React.JSX.Element {
  const [keyDraft, setKeyDraft] = useState('')
  const [braveDraft, setBraveDraft] = useState('')
  const indexLabel: Record<string, string> = {
    indexed: '已索引',
    missing: '未建立索引',
    indexing: '正在建立索引…',
    syncing: '正在同步索引…',
    failed: '索引失败',
    unknown: '索引状态未知'
  }
  const isWarpGrep = engine.id === 'warpgrep'
  const isWeb = engine.id === 'web'
  const webHint = web?.braveKeyHint
  return (
    <div className={`mcp-engine ${engine.enabled ? '' : 'disabled'}`}>
      <div className="mcp-row">
        <div className="mcp-row-main">
          <span className="mcp-row-title">
            {engine.name}
            {engine.version && <span className="mcp-version">v{engine.version.replace(/^v/i, '')}</span>}
            {engine.enabled && <span className="badge">网关</span>}
          </span>
          <span className="mcp-row-sub">
            {isWeb
              ? 'web_search（服务商原生搜索或 Brave）+ web_fetch（本地抓取并转 Markdown）。不需要二进制，只认 Key。'
              : isWarpGrep
                ? 'Morph WarpGrep：自然语言代码搜索，多轮 grep / 读取后在项目内定位代码。默认只返回文件与行号。'
                : '代码索引：符号搜索、调用关系、影响面分析。默认只返回符号与位置，不返回源码。'}
          </span>
          {engine.error && <span className="mcp-row-warn">{engine.error}</span>}
          {isWeb && web && (
            <span className="mcp-row-meta">
              当前路由：{web.route}
              {web.nativeProviders.length > 0 ? ` · 已开启原生：${web.nativeProviders.join(' / ')}` : ''}
              {` · 每次 ${web.count} 条 / 抓取 ${web.maxChars} 字符`}
            </span>
          )}
          {engine.enabled && !engine.error && !isWarpGrep && !isWeb && (
            <span className="mcp-row-meta">
              {indexLabel[engine.index ?? 'unknown']}
              {engine.indexMessage ? ` · ${engine.indexMessage}` : ''}
            </span>
          )}
          {!isWeb && (
            <span className="mcp-row-meta mcp-entry" title={engine.entry}>
              {isWarpGrep
                ? `api.morphllm.com/v1${morphKeyHint ? ` · Key ${morphKeyHint}` : ' · 未配置 Key'}`
                : engine.entry ?? '未找到入口'}
            </span>
          )}
        </div>
        <Toggle
          checked={engine.enabled}
          disabled={busy || !engine.available}
          onChange={(value) => onToggle(engine.id, value)}
        />
      </div>
      {!engine.available && (
        <div className="mcp-install">
          <span>
            {isWeb
              ? 'web_search 还没有后端：填一个 Brave Search API Key，或到 设置 → 服务商 给某个服务商打开「联网」。'
              : isWarpGrep
                ? '未配置 Morph API Key。'
                : '未找到 CodeGraph。安装：'}
          </span>
          {!isWarpGrep && !isWeb && (
            <>
              <code>{INSTALL_HINTS.codegraph}</code>
              <button
                className="ghost"
                onClick={() => void navigator.clipboard?.writeText(INSTALL_HINTS.codegraph)}
              >
                复制
              </button>
              <span className="mcp-install-alt">
                已装在别处？用「选择入口」指定可执行文件（CodeGraph 的 <code>npm-shim.js</code>）。
              </span>
            </>
          )}
          {isWarpGrep && (
            <span className="mcp-install-alt">
              Key 只在本地保存，搜索时随请求发给 Morph；搜索过程中读取的文件片段也会发送到 Morph API。
            </span>
          )}
          {isWeb && (
            <span className="mcp-install-alt">
              web_fetch 不需要 Key，只用 Brave 时需要；服务商原生搜索沿用该服务商已登录的凭据。
            </span>
          )}
        </div>
      )}
      {isWeb ? (
        <>
          <div className="mcp-web-mode">
            <span className="mcp-web-label">搜索来源</span>
            <div className="mcp-seg">
              {(
                [
                  ['auto', '自动'],
                  ['brave', '仅 Brave'],
                  ['native', '仅服务商']
                ] as Array<[WebSearchMode, string]>
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  className={(web?.mode ?? 'auto') === mode ? 'active' : ''}
                  disabled={busy || !engine.enabled}
                  onClick={() => onSetWebMode(mode)}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="mcp-web-note">
              自动：当前服务商开了「联网」就用它的原生搜索，否则用 Brave。
            </span>
          </div>
          <div className="mcp-key-row">
            <input
              type="password"
              value={braveDraft}
              placeholder={webHint ? `已保存 ${webHint}，输入新 Key 覆盖` : 'Brave Search API Key'}
              onChange={(event) => setBraveDraft(event.target.value)}
              spellCheck={false}
            />
            <button
              className="ghost"
              disabled={busy || !braveDraft.trim()}
              onClick={() => {
                onSaveBraveKey(braveDraft.trim())
                setBraveDraft('')
              }}
            >
              保存 Key
            </button>
            {webHint && (
              <button className="ghost" disabled={busy} onClick={() => onSaveBraveKey(null)}>
                清除
              </button>
            )}
          </div>
        </>
      ) : isWarpGrep ? (
        <div className="mcp-key-row">
          <input
            type="password"
            value={keyDraft}
            placeholder={morphKeyHint ? `已保存 ${morphKeyHint}，输入新 Key 覆盖` : 'sk-...'}
            onChange={(event) => setKeyDraft(event.target.value)}
            spellCheck={false}
          />
          <button
            className="ghost"
            disabled={busy || !keyDraft.trim()}
            onClick={() => {
              onSaveKey(keyDraft.trim())
              setKeyDraft('')
            }}
          >
            保存 Key
          </button>
          {morphKeyHint && (
            <button className="ghost" disabled={busy} onClick={() => onSaveKey(null)}>
              清除
            </button>
          )}
        </div>
      ) : (
        <div className="mcp-engine-actions">
          <button className="ghost" disabled={busy} onClick={() => onPickEntry(engine.id)}>
            选择入口
          </button>
          {engine.entry && (
            <button className="ghost" disabled={busy} onClick={() => onClearEntry(engine.id)}>
              恢复自动检测
            </button>
          )}
          <button className="ghost" disabled={busy || !engine.available} onClick={onBuildIndex}>
            立即索引
          </button>
        </div>
      )}
      {engine.enabled && (
        <ToolSection
          server={engine.id}
          tools={engine.tools}
          busy={busy}
          open={toolsOpen}
          onOpenChange={onToolsOpenChange}
          onToggle={onToggleTool}
        />
      )}
    </div>
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
  const [openTools, setOpenTools] = useState<Record<string, boolean>>({})

  const setToolsOpen = useCallback((server: string, open: boolean) => {
    setOpenTools((current) => ({ ...current, [server]: open }))
  }, [])

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
    return window.pi.onMcpState((next) => setState(next))
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

  const toggleTool = useCallback(
    (server: string, tool: string, enabled: boolean) => {
      void run(() => window.pi.setMcpToolEnabled(server, tool, enabled))
    },
    [run]
  )

  const pickEntry = useCallback(
    (id: McpEngineId) => {
      void (async () => {
        const selected = await window.pi.chooseMcpEngineEntry()
        if (!selected) return
        await run(() => window.pi.setMcpEngineEntry(id, selected), '入口已更新')
      })()
    },
    [run]
  )

  const saveKey = useCallback(
    (key: string | null) => {
      void run(() => window.pi.setMorphApiKey(key), key ? 'Morph API Key 已保存' : '已清除 Morph API Key')
    },
    [run]
  )

  const saveBraveKey = useCallback(
    (key: string | null) => {
      void run(
        () => window.pi.setBraveApiKey(key),
        key ? 'Brave Search Key 已保存' : '已清除 Brave Search Key'
      )
    },
    [run]
  )

  const setWebMode = useCallback(
    (mode: WebSearchMode) => {
      const labels: Record<WebSearchMode, string> = {
        auto: '搜索来源：自动（服务商优先，否则 Brave）',
        brave: '搜索来源：仅 Brave',
        native: '搜索来源：仅服务商原生'
      }
      void run(() => window.pi.setWebSearchMode(mode), labels[mode])
    },
    [run]
  )

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
      </div>

      <div className="field">
        <div className="mcp-head">
          <label>内置工具</label>
          <div className="mcp-head-actions">
            <button
              className="icon-btn"
              title="重新检测引擎"
              onClick={() => void run(() => window.pi.refreshMcpEngines())}
            >
              <RefreshIcon size={13} />
            </button>
          </div>
        </div>

        <div className="mcp-row">
          <div className="mcp-row-main">
            <span className="mcp-row-title">
              桌面交互 <code>desktop</code>
            </span>
            <span className="mcp-row-sub">
              核心交互 MCP 服务器，当前提供 <code>ask_user_question</code>：单选、多选、手动输入，
              多问题按顺序回答。通过 <code>--extension</code> 注入，不写入 mcp.json。
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
                value ? '桌面交互工具已启用' : '桌面交互工具已关闭'
              )
            }
          />
        </div>
        {state?.desktopTool && (
          <ToolSection
            server="desktop"
            tools={state.desktopTools}
            busy={busy}
            open={openTools.desktop === true}
            onOpenChange={(open) => setToolsOpen('desktop', open)}
            onToggle={toggleTool}
          />
        )}

        {state?.engines.map((engine) => (
          <EngineCard
            key={engine.id}
            engine={engine}
            busy={busy}
            morphKeyHint={state.morphKeyHint}
            web={state.web}
            toolsOpen={openTools[engine.id] === true}
            onToolsOpenChange={(open) => setToolsOpen(engine.id, open)}
            onToggle={(id, enabled) =>
              void run(
                () => window.pi.setMcpEngineEnabled(id, enabled),
                `${ENGINE_LABELS[id] ?? id}${enabled ? ' 已启用' : ' 已关闭'}`
              )
            }
            onPickEntry={pickEntry}
            onClearEntry={(id) => void run(() => window.pi.setMcpEngineEntry(id, null))}
            onBuildIndex={() =>
              void run(async () => {
                const result = await window.pi.buildMcpIndex()
                if (!result.ok) throw new Error(result.message)
                onNotice(result.message)
              })
            }
            onSaveKey={saveKey}
            onSaveBraveKey={saveBraveKey}
            onSetWebMode={setWebMode}
            onToggleTool={toggleTool}
          />
        ))}
        {!state && loading && <div className="provider-empty">正在检测内置引擎…</div>}
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
