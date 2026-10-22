import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppSettings,
  AppUpdateSnapshot,
  DesktopConfig,
  LoginEvent,
  LoginPrompt,
  ModelChoice,
  PiStatus,
  ProviderAuthType,
  ProviderInfo,
  ProviderModelOption,
  ProxyInfo
} from '@shared/types'
import {
  CheckIcon,
  CloseIcon,
  CopyIcon,
  ExternalIcon,
  FolderIcon,
  KeyIcon,
  ListIcon,
  LogoutIcon,
  MoonIcon,
  PlugIcon,
  RefreshIcon,
  SearchIcon,
  SunIcon,
  UserIcon
} from './Icons'
import { CustomProvidersPanel } from './CustomProvidersPanel'
import { McpPanel } from './McpPanel'
import { updateBusy, updateProgress, updateStatusText } from '../lib/updates'

type Tab = 'providers' | 'custom' | 'mcp' | 'general'

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

interface LoginState {
  loginId: string
  providerName: string
  method: ProviderAuthType
  prompt?: { promptId: string; prompt: LoginPrompt }
  events: LoginEvent[]
  result?: { ok: boolean; error?: string }
  submitting?: boolean
}

interface ModelConfigState {
  provider: ProviderInfo
  models: ProviderModelOption[]
  selected: Set<string>
  query: string
  loading: boolean
  saving: boolean
  error?: string
}

const SOURCE_LABELS: Record<string, string> = {
  stored: '已保存凭据',
  runtime: '本次运行',
  environment: '环境变量',
  fallback: '回退配置',
  models_json_key: 'models.json',
  models_json_command: 'models.json 命令'
}

const PROVIDER_NOTES: Record<string, string> = {
  openai: 'ChatGPT 订阅或 OpenAI API Key，使用标准 OpenAI 模型',
  'openai-codex': '旧版 Codex 渠道，仅支持 ChatGPT Plus/Pro 订阅，模型较少',
  anthropic: 'Claude 订阅（OAuth）或 Anthropic API Key'
}

function PromptInput({
  prompt,
  disabled,
  onSubmit
}: {
  prompt: LoginPrompt
  disabled?: boolean
  onSubmit: (value: string) => void
}) {
  const [value, setValue] = useState('')

  useEffect(() => {
    setValue('')
  }, [prompt])

  if (prompt.type === 'select') {
    return (
      <div className="login-select">
        {prompt.options?.map((option) => (
          <button
            key={option.id}
            className="login-option"
            disabled={disabled}
            onClick={() => onSubmit(option.id)}
          >
            <span>{option.label}</span>
            {option.description && <small>{option.description}</small>}
          </button>
        ))}
      </div>
    )
  }

  return (
    <form
      className="login-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (!value.trim() || disabled) return
        onSubmit(value.trim())
      }}
    >
      <label>{prompt.message}</label>
      <div className="login-input-row">
        <input
          autoFocus
          type={prompt.type === 'secret' ? 'password' : 'text'}
          value={value}
          disabled={disabled}
          placeholder={prompt.placeholder ?? ''}
          onChange={(event) => setValue(event.target.value)}
          spellCheck={false}
        />
        <button type="submit" className="primary" disabled={disabled || !value.trim()}>
          继续
        </button>
      </div>
    </form>
  )
}

function LoginDialog({
  login,
  onAnswer,
  onCancel,
  onClose,
  onOpenExternal
}: {
  login: LoginState
  onAnswer: (value: string) => void
  onCancel: () => void
  onClose: () => void
  onOpenExternal: (url: string) => void
}) {
  const authUrl = login.events.find((event) => event.type === 'auth_url')
  const deviceCode = login.events.find((event) => event.type === 'device_code')

  return (
    <div className="login-backdrop">
      <div className="login-dialog">
        <header>
          <div>
            <h3>登录 {login.providerName}</h3>
            <p>{login.method === 'oauth' ? 'OAuth / 订阅账号' : 'API Key'}</p>
          </div>
          <button className="icon-btn" onClick={login.result ? onClose : onCancel} title="关闭">
            <CloseIcon size={14} />
          </button>
        </header>

        <div className="login-events">
          {login.events.map((event, index) => {
            if (event.type === 'info') {
              return (
                <div key={index} className="login-event">
                  <span>{event.message}</span>
                  {event.links?.map((link) => (
                    <button key={link.url} className="link-btn" onClick={() => onOpenExternal(link.url)}>
                      {link.label ?? link.url}
                    </button>
                  ))}
                </div>
              )
            }
            if (event.type === 'auth_url') {
              return (
                <div key={index} className="login-event">
                  <span>浏览器已打开授权页面</span>
                  <button className="link-btn" onClick={() => onOpenExternal(event.url)}>
                    <ExternalIcon size={12} /> 重新打开授权页
                  </button>
                  {event.instructions && <small>{event.instructions}</small>}
                </div>
              )
            }
            if (event.type === 'device_code') {
              return (
                <div key={index} className="login-event device">
                  <span>在设备上输入以下代码：</span>
                  <div className="device-code">
                    <code>{event.userCode}</code>
                    <button
                      className="icon-btn"
                      title="复制"
                      onClick={() => void navigator.clipboard?.writeText(event.userCode)}
                    >
                      <CopyIcon size={13} />
                    </button>
                  </div>
                  <button className="link-btn" onClick={() => onOpenExternal(event.verificationUri)}>
                    <ExternalIcon size={12} /> {event.verificationUri}
                  </button>
                </div>
              )
            }
            return (
              <div key={index} className="login-event progress">
                <span className="spinner" /> {event.message}
              </div>
            )
          })}
          {login.events.length === 0 && !login.prompt && !login.result && (
            <div className="login-event progress">
              <span className="spinner" /> 正在启动登录流程…
            </div>
          )}
        </div>

        {login.prompt && (
          <PromptInput prompt={login.prompt.prompt} disabled={login.submitting} onSubmit={onAnswer} />
        )}

        {!login.prompt && !login.result && (authUrl || deviceCode) && (
          <p className="login-waiting">等待浏览器完成授权…</p>
        )}

        {login.result && (
          <div className={`login-result ${login.result.ok ? 'ok' : 'error'}`}>
            {login.result.ok ? (
              <>
                <CheckIcon size={15} /> 登录成功，凭据已写入 auth.json。
              </>
            ) : (
              <>登录失败：{login.result.error}</>
            )}
          </div>
        )}

        <footer>
          {login.result ? (
            <button className="primary" onClick={onClose}>
              完成
            </button>
          ) : (
            <button className="ghost" onClick={onCancel}>
              取消
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

export function SettingsModal({
  open,
  initialTab,
  status,
  theme,
  onThemeChange,
  update,
  onCheckUpdate,
  onInstallUpdate,
  onCancelUpdate,
  onSetAutoUpdate,
  onOpenReleases,
  onClose,
  onRestart,
  onChooseWorkspace
}: {
  open: boolean
  initialTab?: Tab
  status: PiStatus
  theme: 'dark' | 'light'
  onThemeChange: (theme: 'dark' | 'light') => void
  update: AppUpdateSnapshot
  onCheckUpdate: () => void
  onInstallUpdate: () => void
  onCancelUpdate: () => void
  onSetAutoUpdate: (enabled: boolean) => void
  onOpenReleases: () => void
  onClose: () => void
  onRestart: () => Promise<void> | void
  onChooseWorkspace: () => Promise<void> | void
}) {
  const [tab, setTab] = useState<Tab>(initialTab ?? 'providers')
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [providersLoading, setProvidersLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [loadError, setLoadError] = useState<string>()
  const [login, setLogin] = useState<LoginState>()
  const [modelsJson, setModelsJson] = useState<{ path: string; content: string }>()
  const [modelsContent, setModelsContent] = useState('')
  const [modelsDirty, setModelsDirty] = useState(false)
  const [settings, setSettings] = useState<AppSettings>()
  const [desktopConfig, setDesktopConfig] = useState<DesktopConfig>()
  const [proxyInfo, setProxyInfo] = useState<ProxyInfo>()
  const [models, setModels] = useState<ModelChoice[]>([])
  const [defaultProvider, setDefaultProvider] = useState('')
  const [defaultModel, setDefaultModel] = useState('')
  const [defaultThinking, setDefaultThinking] = useState('')
  const [notice, setNotice] = useState<string>()
  const [error, setError] = useState<string>()
  const [confirmLogout, setConfirmLogout] = useState<string>()
  const [modelConfig, setModelConfig] = useState<ModelConfigState>()

  const loginRef = useRef<LoginState | undefined>(undefined)
  loginRef.current = login

  const loadProviders = useCallback(async () => {
    setProvidersLoading(true)
    try {
      setProviders(await window.pi.listProviders())
      setLoadError(undefined)
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setProvidersLoading(false)
    }
  }, [])

  const loadSettings = useCallback(async () => {
    try {
      const [nextSettings, nextModels, nextDesktop, nextProxy] = await Promise.all([
        window.pi.getAppSettings(),
        window.pi.listModelChoices(),
        window.pi.getDesktopConfig(),
        window.pi.getProxyInfo()
      ])
      setSettings(nextSettings)
      setModels(nextModels)
      setDesktopConfig(nextDesktop)
      setProxyInfo(nextProxy)
      setDefaultProvider(nextSettings.defaultProvider ?? '')
      setDefaultModel(nextSettings.defaultModel ?? '')
      setDefaultThinking(nextSettings.defaultThinkingLevel ?? '')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  const loadModelsJson = useCallback(async () => {
    const file = await window.pi.getModelsJson()
    setModelsJson(file)
    setModelsContent(file.content)
    setModelsDirty(false)
  }, [])

  useEffect(() => {
    if (!open) return
    setTab(initialTab ?? 'providers')
    setNotice(undefined)
    setError(undefined)
    void loadProviders()
    void loadSettings()
  }, [open, initialTab, loadProviders, loadSettings])

  useEffect(() => {
    if (open && tab === 'custom') void loadModelsJson()
  }, [open, tab, loadModelsJson])

  useEffect(
    () =>
      window.pi.onLoginMessage((message) => {
        setLogin((current) => {
          if (!current || current.loginId !== message.loginId) return current
          if (message.kind === 'prompt') {
            return { ...current, prompt: { promptId: message.promptId, prompt: message.prompt } }
          }
          if (message.kind === 'event') {
            return { ...current, events: [...current.events, message.event] }
          }
          return {
            ...current,
            prompt: undefined,
            submitting: false,
            result: { ok: message.ok, error: message.error }
          }
        })
        if (message.kind === 'done') {
          void loadProviders()
          void loadSettings()
        }
      }),
    [loadProviders, loadSettings]
  )

  useEffect(() => {
    if (!open) return
    const handler = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (loginRef.current) {
        if (!loginRef.current.result) {
          window.pi.cancelLogin(loginRef.current.loginId)
        }
        setLogin(undefined)
      } else {
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  useEffect(() => {
    if (!notice && !error) return
    const timer = setTimeout(() => {
      setNotice(undefined)
      setError(undefined)
    }, 6000)
    return () => clearTimeout(timer)
  }, [notice, error])

  const filteredProviders = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return providers
    return providers.filter(
      (provider) =>
        provider.name.toLowerCase().includes(needle) || provider.id.toLowerCase().includes(needle)
    )
  }, [providers, query])

  const configuredCount = providers.filter((provider) => provider.configured).length

  const providerChoices = useMemo(() => {
    const map = new Map<string, string>()
    for (const model of models) map.set(model.provider, model.providerName)
    return [...map.entries()].map(([id, name]) => ({ id, name }))
  }, [models])

  const filteredModels = useMemo(
    () => models.filter((model) => !defaultProvider || model.provider === defaultProvider),
    [models, defaultProvider]
  )

  const builtinIds = useMemo(
    () => new Set(providers.filter((provider) => provider.builtin).map((provider) => provider.id)),
    [providers]
  )

  const filteredProviderModels = useMemo(() => {
    if (!modelConfig) return []
    const needle = modelConfig.query.trim().toLowerCase()
    return modelConfig.models.filter((model) => {
      if (!needle) return true
      return `${model.name ?? ''} ${model.modelId}`.toLowerCase().includes(needle)
    })
  }, [modelConfig])

  const startLogin = useCallback(
    async (provider: ProviderInfo, type: ProviderAuthType) => {
      const loginId = crypto.randomUUID()
      setLogin({
        loginId,
        providerName: provider.name,
        method: type,
        events: []
      })
      const result = await window.pi
        .startLogin(provider.id, type, loginId)
        .catch((cause: unknown) => ({
          error: cause instanceof Error ? cause.message : String(cause)
        }))
      if (result.error) {
        setLogin((current) =>
          current ? { ...current, result: { ok: false, error: result.error } } : current
        )
      }
    },
    []
  )

  const answerLogin = useCallback(
    async (value: string) => {
      const current = loginRef.current
      if (!current?.prompt) return
      setLogin((state) => (state ? { ...state, submitting: true, prompt: undefined } : state))
      await window.pi.answerLogin(current.loginId, current.prompt.promptId, value)
    },
    []
  )

  const cancelLogin = useCallback(() => {
    const current = loginRef.current
    if (current) window.pi.cancelLogin(current.loginId)
    setLogin(undefined)
  }, [])

  const logout = useCallback(
    async (provider: ProviderInfo) => {
      if (confirmLogout !== provider.id) {
        setConfirmLogout(provider.id)
        setTimeout(() => setConfirmLogout((value) => (value === provider.id ? undefined : value)), 4000)
        return
      }
      setConfirmLogout(undefined)
      const result = await window.pi.logoutProvider(provider.id)
      if (result.ok) {
        setNotice(`已退出 ${provider.name}`)
        void loadProviders()
      } else {
        setError(result.error ?? '退出失败')
      }
    },
    [confirmLogout, loadProviders]
  )

  const openModelConfig = useCallback(async (provider: ProviderInfo) => {
    setModelConfig({
      provider,
      models: [],
      selected: new Set(),
      query: '',
      loading: true,
      saving: false
    })
    try {
      const models = await window.pi.listProviderModels(provider.id)
      setModelConfig((prev) =>
        prev && prev.provider.id === provider.id
          ? {
              ...prev,
              models,
              selected: new Set(models.filter((model) => model.enabled).map((model) => model.id)),
              loading: false
            }
          : prev
      )
    } catch (cause) {
      setModelConfig((prev) =>
        prev
          ? {
              ...prev,
              loading: false,
              error: cause instanceof Error ? cause.message : String(cause)
            }
          : prev
      )
    }
  }, [])

  const toggleModel = useCallback((id: string) => {
    setModelConfig((prev) => {
      if (!prev) return prev
      const selected = new Set(prev.selected)
      if (selected.has(id)) selected.delete(id)
      else selected.add(id)
      return { ...prev, selected }
    })
  }, [])

  const setAllModels = useCallback((enabled: boolean) => {
    setModelConfig((prev) =>
      prev
        ? {
            ...prev,
            selected: enabled ? new Set(prev.models.map((model) => model.id)) : new Set()
          }
        : prev
    )
  }, [])

  const saveModelConfig = useCallback(async () => {
    const current = modelConfig
    if (!current) return
    setModelConfig({ ...current, saving: true, error: undefined })
    const result = await window.pi.setProviderModels(current.provider.id, [...current.selected])
    if (!result.ok) {
      setModelConfig((prev) =>
        prev ? { ...prev, saving: false, error: result.error ?? '保存失败' } : prev
      )
      return
    }
    setModelConfig(undefined)
    setNotice(`${current.provider.name} 的模型列表已保存`)
    void loadProviders()
    void loadSettings()
  }, [modelConfig, loadProviders, loadSettings])

  const changeSessionMode = useCallback(async (mode: 'shared' | 'isolated') => {
    const next = await window.pi.setSessionMode(mode)
    if (next.phase === 'error') {
      setError(next.error ?? '切换会话存储失败')
      return
    }
    setDesktopConfig(await window.pi.getDesktopConfig())
    setNotice(
      mode === 'isolated'
        ? '已切换到独立会话目录，并新建了会话'
        : '已切换到共用 pi 会话目录，并新建了会话'
    )
  }, [])

  const saveModels = useCallback(
    async (content: string = modelsContent) => {
      const result = await window.pi.saveModelsJson(content)
      if (result.ok) {
        setNotice('models.json 已保存，pi 正在重启')
        setModelsContent(content)
        setModelsDirty(false)
        void loadProviders()
        void loadSettings()
      } else {
        setError(result.error ?? '保存失败')
      }
    },
    [modelsContent, loadProviders, loadSettings]
  )

  const saveGeneral = useCallback(async () => {    const result = await window.pi.saveAppSettings({
      defaultProvider: defaultProvider || '',
      defaultModel: defaultModel || '',
      defaultThinkingLevel: defaultThinking || ''
    })
    if (result.ok) {
      setNotice('默认模型已保存，pi 正在重启')
      void loadSettings()
    } else {
      setError(result.error ?? '保存失败')
    }
  }, [defaultProvider, defaultModel, defaultThinking, loadSettings])

  if (!open) return null

  const progress = updateProgress(update)

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="settings">
        <aside className="settings-nav">
          <div className="settings-title">
            <span className="wordmark-mark">π</span>
            <span>设置</span>
          </div>
          <button
            className={tab === 'providers' ? 'active' : ''}
            onClick={() => setTab('providers')}
          >
            <UserIcon size={15} /> 服务商
            <span className="nav-count">{configuredCount}</span>
          </button>
          <button className={tab === 'custom' ? 'active' : ''} onClick={() => setTab('custom')}>
            <KeyIcon size={15} /> 自定义服务商
          </button>
          <button className={tab === 'mcp' ? 'active' : ''} onClick={() => setTab('mcp')}>
            <PlugIcon size={15} /> MCP
          </button>
          <button className={tab === 'general' ? 'active' : ''} onClick={() => setTab('general')}>
            <FolderIcon size={15} /> 通用
          </button>
          <div className="settings-nav-foot">
            <span className={`status-dot ${status.phase}`} />
            <span>pi {status.phase === 'ready' ? '已连接' : status.phase === 'starting' ? '启动中' : '未连接'}</span>
          </div>
        </aside>

        <section className="settings-body">
          <header className="settings-head">
            <div>
              <h2>
                {tab === 'providers'
                  ? '服务商'
                  : tab === 'custom'
                    ? '自定义服务商'
                    : tab === 'mcp'
                      ? 'MCP'
                      : '通用'}
              </h2>
              <p>
                {tab === 'providers'
                  ? '使用 pi 内置的 OAuth 或 API Key 登录，凭据保存到 ~/.pi/agent/auth.json'
                  : tab === 'custom'
                    ? '通过 models.json 配置 OpenAI 兼容端点、baseUrl 与模型列表'
                    : tab === 'mcp'
                      ? 'MCP 总开关、桌面提问工具与 ~/.pi/agent/mcp.json 里的服务器'
                      : '当前会话目录、会话存储、默认模型与思考等级'}
              </p>
            </div>
            <button className="icon-btn" onClick={onClose} title="关闭 (Esc)">
              <CloseIcon size={15} />
            </button>
          </header>

          {(notice || error) && (
            <div className={`settings-message ${error ? 'error' : 'ok'}`}>{error ?? notice}</div>
          )}

          {tab === 'providers' && (
            <div className="settings-content providers">
              <div className="providers-toolbar">
                <div className="search-box">
                  <SearchIcon size={13} />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索服务商"
                    spellCheck={false}
                  />
                </div>
                <button className="icon-btn" title="刷新" onClick={() => void loadProviders()}>
                  <RefreshIcon size={14} />
                </button>
                <span className="providers-count">
                  {providersLoading ? '加载中…' : `${configuredCount} / ${providers.length} 已配置`}
                </span>
              </div>

              {loadError && <div className="settings-message error">{loadError}</div>}

              <div className="provider-list">
                {filteredProviders.map((provider) => (
                  <div
                    key={provider.id}
                    className={`provider-row ${provider.configured ? 'configured' : ''}`}
                  >
                    <div className="provider-mark">{provider.name.slice(0, 1).toUpperCase()}</div>
                    <div className="provider-main">
                      <div className="provider-name">
                        {provider.name}
                        {provider.configured && (
                          <span className="badge ok">
                            {provider.storedType
                              ? provider.storedType === 'oauth'
                                ? 'OAuth'
                                : 'API Key'
                              : SOURCE_LABELS[provider.source ?? ''] ?? '已配置'}
                          </span>
                        )}
                      </div>
                      <div className="provider-sub">
                        <code>{provider.id}</code>
                        <span>{provider.modelCount} 个模型</span>
                        {provider.sourceLabel && <span>{provider.sourceLabel}</span>}
                      </div>
                      {PROVIDER_NOTES[provider.id] && (
                        <div className="provider-note">{PROVIDER_NOTES[provider.id]}</div>
                      )}
                    </div>
                    <div className="provider-actions">
                      {provider.options.map((option) => (
                        <button
                          key={option.type}
                          className={`prov-btn ${option.type}`}
                          onClick={() => void startLogin(provider, option.type)}
                        >
                          {option.type === 'oauth' ? <UserIcon size={12} /> : <KeyIcon size={12} />}
                          {option.label}
                        </button>
                      ))}
                      <button
                        className="prov-btn ghost"
                        onClick={() => void openModelConfig(provider)}
                        title="配置模型列表，隐藏不想用的模型"
                      >
                        <ListIcon size={12} /> 模型
                      </button>
                      {provider.storedType && (
                        <button
                          className={`prov-btn ghost ${confirmLogout === provider.id ? 'danger' : ''}`}
                          onClick={() => void logout(provider)}
                          title="删除已保存的凭据"
                        >
                          <LogoutIcon size={12} />
                          {confirmLogout === provider.id ? '确认退出' : '退出'}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                {filteredProviders.length === 0 && (
                  <div className="provider-empty">
                    {providersLoading
                      ? '正在加载服务商…'
                      : providers.length === 0
                        ? '没有可用的服务商'
                        : '没有匹配的服务商'}
                  </div>
                )}
              </div>
            </div>
          )}

          {tab === 'custom' && (
            <CustomProvidersPanel
              filePath={modelsJson?.path ?? '~/.pi/agent/models.json'}
              content={modelsContent}
              dirty={modelsDirty}
              builtinIds={builtinIds}
              onChange={(value) => {
                setModelsContent(value)
                setModelsDirty(true)
              }}
              onSave={saveModels}
              onReload={() => void loadModelsJson()}
              onOpenFile={() => void window.pi.openModelsJson()}
            />
          )}

          {tab === 'mcp' && <McpPanel onNotice={setNotice} onError={setError} />}

          {tab === 'general' && (
            <div className="settings-content general">
              <div className="field">
                <label>当前会话目录</label>
                <div className="field-row">
                  <code className="path">{status.cwd}</code>
                  <button
                    className="ghost"
                    onClick={() => void onChooseWorkspace()}
                    title="选择目录并在该目录新建会话"
                  >
                    <FolderIcon size={12} /> 在新目录新建
                  </button>
                </div>
                <p className="field-hint">
                  每个会话按所属项目目录运行；在侧栏切换会话时会自动切换 pi 的工作目录。
                </p>
              </div>

              <div className="field">
                <label>会话存储</label>
                <div className="theme-switch storage-switch">
                  <button
                    className={desktopConfig?.sessionMode !== 'isolated' ? 'active' : ''}
                    onClick={() => void changeSessionMode('shared')}
                  >
                    共用 pi
                  </button>
                  <button
                    className={desktopConfig?.sessionMode === 'isolated' ? 'active' : ''}
                    onClick={() => void changeSessionMode('isolated')}
                  >
                    独立目录
                  </button>
                </div>
                <p className="field-hint">
                  共用：<code>{desktopConfig?.sharedSessionDir ?? '~/.pi/agent/sessions'}</code>
                  ，与 pi CLI/TUI 使用同一批 JSONL 会话，结构不变。
                </p>
                <p className="field-hint">
                  独立：<code>{desktopConfig?.isolatedSessionDir ?? '应用数据目录/sessions'}</code>
                  ，只给桌面端使用，文件格式与 pi 完全一致，可随时切回共用。
                </p>
              </div>

              <div className="field">
                <label>网络代理</label>
                <div className="field-row">
                  <code className="path">
                    {proxyInfo?.proxy ?? '未检测到系统代理（直连）'}
                  </code>
                </div>
                <p className="field-hint">
                  自动读取 Windows 系统代理（Clash 等）；OAuth、更新检查和 pi 子进程都会继承该代理。
                </p>
              </div>

              <div className="field">
                <label>软件更新</label>
                <div className="update-card">
                  <div className="update-row">
                    <div className="update-info">
                      <div className="update-version">当前版本 {update.currentVersion}</div>
                      <div className={`update-status ${update.status}`}>
                        {updateStatusText(update)}
                        {update.latestVersion ? ` · 最新 ${update.latestVersion}` : ''}
                      </div>
                      {update.checkedAt && (
                        <div className="update-checked">
                          上次检查：
                          {new Date(update.checkedAt).toLocaleString('zh-CN')}
                        </div>
                      )}
                    </div>
                    <div className="update-actions">
                      <button
                        className="ghost"
                        onClick={onCheckUpdate}
                        disabled={updateBusy(update)}
                      >
                        <RefreshIcon size={12} /> 检查更新
                      </button>
                      {update.canInstall &&
                        update.latestVersion &&
                        update.status === 'available' && (
                          <button className="primary" onClick={onInstallUpdate}>
                            下载并安装
                          </button>
                        )}
                      {update.status === 'downloading' && (
                        <button className="ghost" onClick={onCancelUpdate}>
                          取消下载
                        </button>
                      )}
                    </div>
                  </div>

                  {update.status === 'downloading' && (
                    <div className="update-progress">
                      <div className="update-progress-bar">
                        <span style={{ width: `${progress ?? 0}%` }} />
                      </div>
                      <span>
                        {(update.downloaded / 1024 / 1024).toFixed(1)} MB
                        {update.total
                          ? ` / ${(update.total / 1024 / 1024).toFixed(1)} MB`
                          : ''}
                        {progress !== null ? ` · ${progress}%` : ''}
                      </span>
                    </div>
                  )}

                  {update.notes && (
                    <details className="update-notes">
                      <summary>更新说明</summary>
                      <pre>{update.notes}</pre>
                    </details>
                  )}

                  {!update.canInstall && (
                    <p className="field-hint">
                      当前是开发 / 未打包模式，只能检测版本，无法应用安装包。
                    </p>
                  )}
                  {update.error && (
                    <div className="settings-message error">{update.error.message}</div>
                  )}

                  <div className="update-footer">
                    <label className="update-auto">
                      <input
                        type="checkbox"
                        checked={update.autoCheck}
                        disabled={updateBusy(update)}
                        onChange={(event) => onSetAutoUpdate(event.target.checked)}
                      />
                      自动检查更新（启动后及每 6 小时）
                    </label>
                    <button className="update-link" onClick={onOpenReleases}>
                      打开 GitHub 发布页
                    </button>
                  </div>
                </div>
              </div>

              <div className="field-grid">
                <div className="field">
                  <label>默认服务商</label>
                  <select
                    value={defaultProvider}
                    onChange={(event) => {
                      setDefaultProvider(event.target.value)
                      setDefaultModel('')
                    }}
                  >
                    <option value="">自动</option>
                    {providerChoices.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>默认模型</label>
                  <select
                    value={defaultModel}
                    onChange={(event) => setDefaultModel(event.target.value)}
                  >
                    <option value="">自动</option>
                    {filteredModels.map((model) => (
                      <option key={`${model.provider}/${model.id}`} value={model.id}>
                        {model.name ?? model.id}
                        {model.configured ? '' : '（未配置凭据）'}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>思考等级</label>
                  <select
                    value={defaultThinking}
                    onChange={(event) => setDefaultThinking(event.target.value)}
                  >
                    <option value="">自动</option>
                    {THINKING_LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="field">
                <label>外观</label>
                <div className="theme-switch">
                  <button
                    className={theme === 'dark' ? 'active' : ''}
                    onClick={() => onThemeChange('dark')}
                  >
                    <MoonIcon size={13} /> 深色
                  </button>
                  <button
                    className={theme === 'light' ? 'active' : ''}
                    onClick={() => onThemeChange('light')}
                  >
                    <SunIcon size={13} /> 亮色
                  </button>
                </div>
              </div>

              <div className="general-actions">
                <button className="primary" onClick={() => void saveGeneral()}>
                  保存并重启 pi
                </button>
                <button className="ghost" onClick={() => void onRestart()}>
                  <RefreshIcon size={12} /> 仅重启 pi
                </button>
                <button className="ghost" onClick={() => void window.pi.openAgentDir()}>
                  <FolderIcon size={12} /> 打开配置目录
                </button>
              </div>

              <div className="paths">
                <div>
                  <span>settings.json</span>
                  <code>{settings?.settingsPath ?? '~/.pi/agent/settings.json'}</code>
                </div>
                <div>
                  <span>auth.json</span>
                  <code>{settings?.authPath ?? '~/.pi/agent/auth.json'}</code>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>

      {modelConfig && (
        <div className="login-backdrop">
          <div className="model-config-dialog">
            <header>
              <div>
                <h3>{modelConfig.provider.name} 模型</h3>
                <p>勾选要保留在模型列表中的模型，未勾选的会隐藏</p>
              </div>
              <button className="icon-btn" onClick={() => setModelConfig(undefined)} title="关闭">
                <CloseIcon size={14} />
              </button>
            </header>

            <div className="model-config-search">
              <SearchIcon size={13} />
              <input
                autoFocus
                value={modelConfig.query}
                onChange={(event) =>
                  setModelConfig((prev) =>
                    prev ? { ...prev, query: event.target.value } : prev
                  )
                }
                placeholder="搜索模型"
                spellCheck={false}
              />
            </div>

            <div className="model-config-list">
              {modelConfig.loading && <div className="model-config-empty">加载模型列表…</div>}
              {!modelConfig.loading && filteredProviderModels.length === 0 && (
                <div className="model-config-empty">没有匹配的模型</div>
              )}
              {filteredProviderModels.map((model) => (
                <label key={model.id} className="model-config-row">
                  <input
                    type="checkbox"
                    checked={modelConfig.selected.has(model.id)}
                    onChange={() => toggleModel(model.id)}
                  />
                  <span className="model-config-name">{model.name ?? model.modelId}</span>
                  <span className="model-config-meta">
                    {model.modelId}
                    {model.contextWindow
                      ? ` · ${Math.round(model.contextWindow / 1000)}K`
                      : ''}
                  </span>
                </label>
              ))}
            </div>

            {modelConfig.error && <div className="model-picker-error">{modelConfig.error}</div>}

            <footer>
              <span className="model-config-count">
                已启用 {modelConfig.selected.size} / {modelConfig.models.length}
              </span>
              <div className="model-config-actions">
                <button className="ghost" onClick={() => setAllModels(true)}>
                  全选
                </button>
                <button className="ghost" onClick={() => setAllModels(false)}>
                  全不选
                </button>
                <button className="ghost" onClick={() => setModelConfig(undefined)}>
                  取消
                </button>
                <button
                  className="primary"
                  onClick={() => void saveModelConfig()}
                  disabled={modelConfig.saving || modelConfig.loading}
                >
                  保存
                </button>
              </div>
            </footer>
          </div>
        </div>
      )}

      {login && (
        <LoginDialog
          login={login}
          onAnswer={(value) => void answerLogin(value)}
          onCancel={cancelLogin}
          onClose={() => setLogin(undefined)}
          onOpenExternal={(url) => void window.pi.openExternal(url)}
        />
      )}
    </div>
  )
}
