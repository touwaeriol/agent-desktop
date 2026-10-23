import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppSettings,
  AppUpdateSnapshot,
  DesktopConfig,
  LoginEvent,
  LoginPrompt,
  McpWebState,
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
  GlobeIcon,
  SparkIcon,
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
import { AgentsPanel } from './AgentsPanel'
import { ProviderMark } from './ProviderMark'
import { Toggle } from './Toggle'
import { updateBusy, updateProgress, updateStatusText } from '../lib/updates'

type Tab = 'providers' | 'custom' | 'mcp' | 'agents' | 'general'

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Trigger points offered in the auto-compaction row; any 10–99 value is accepted by the backend. */
const COMPACT_PERCENT_PRESETS = [50, 60, 70, 75, 80, 85, 90, 95]

/** `349K` / `1M` — the same shape the composer's context meter uses. */
function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
  }
  if (value >= 1000) {
    const thousands = value / 1000
    return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1)}K`
  }
  return String(value)
}

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
  anthropic: 'Claude 订阅（OAuth）或 Anthropic API Key',
  deepseek: '国内海外同一个域名；Anthropic 兼容接口在 /anthropic，联网搜索走的就是它',
  'moonshotai-cn': 'Kimi 国内：api.moonshot.cn',
  moonshotai: 'Kimi 海外：api.moonshot.ai',
  'kimi-coding': 'Kimi 订阅（Coding 套餐）：api.kimi.com/coding',
  'minimax-cn': 'MiniMax 国内：api.minimaxi.com（Anthropic 兼容）',
  minimax: 'MiniMax 海外：api.minimax.io（Anthropic 兼容）',
  zai: 'Z.AI 海外 Coding 套餐：api.z.ai',
  'zai-coding-cn': 'Z.AI 国内 Coding 套餐：open.bigmodel.cn',
  'google-vertex': 'Vertex AI：需要项目与区域，走 GCP 凭据',
  google: 'AI Studio（Gemini API）：generativelanguage.googleapis.com'
}

/** Default endpoint shown as the placeholder when a provider's URL can be overridden. */
const BASE_URL_PLACEHOLDER: Record<string, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  deepseek: 'https://api.deepseek.com'
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
  const dialogRef = useRef<HTMLDivElement>(null)
  const [dialogSize, setDialogSize] = useState<{ width: number; height: number } | undefined>(() => {
    try {
      const raw = localStorage.getItem('pi-settings-size')
      if (!raw) return undefined
      const parsed = JSON.parse(raw) as { width?: number; height?: number }
      if (!parsed.width || !parsed.height) return undefined
      return { width: parsed.width, height: parsed.height }
    } catch {
      return undefined
    }
  })
  const dialogStyle = dialogSize
    ? { width: `${dialogSize.width}px`, height: `${dialogSize.height}px` }
    : undefined

  // Remember the size the user dragged the dialog to; the CSS resize handle does the rest.
  useEffect(() => {
    const element = dialogRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    let timer: number | undefined
    const observer = new ResizeObserver(() => {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const width = Math.round(element.getBoundingClientRect().width)
        const height = Math.round(element.getBoundingClientRect().height)
        localStorage.setItem('pi-settings-size', JSON.stringify({ width, height }))
        setDialogSize({ width, height })
      }, 400)
    })
    observer.observe(element)
    return () => {
      if (timer) window.clearTimeout(timer)
      observer.disconnect()
    }
  }, [open])
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
  const [webSearch, setWebSearch] = useState<McpWebState>()
  const [webBusy, setWebBusy] = useState(false)
  /** Auto-compaction trigger as a percentage of the window; kept in sync with `status`. */
  const [compactPercent, setCompactPercent] = useState('')
  const [compactBusy, setCompactBusy] = useState(false)
  /** Provider whose endpoint editor is open, plus the draft value. */
  const [baseUrlEdit, setBaseUrlEdit] = useState<string>()
  const [baseUrlDraft, setBaseUrlDraft] = useState('')
  const [baseUrlBusy, setBaseUrlBusy] = useState(false)

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

  /**
   * Save (or clear) a provider's custom endpoint. pi reads `models.json` at startup, so the main
   * side restarts the session; the provider list is reloaded to show the new value.
   */
  const saveBaseUrl = useCallback(
    async (provider: ProviderInfo, value: string | null) => {
      setBaseUrlBusy(true)
      try {
        const result = await window.pi.setProviderBaseUrl(provider.id, value)
        if (!result.ok) {
          setError(result.error ?? '保存失败')
          return
        }
        setBaseUrlEdit(undefined)
        setNotice(
          value
            ? `${provider.name} 的接口地址已改为 ${value}`
            : `${provider.name} 已恢复默认接口地址`
        )
        await loadProviders()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBaseUrlBusy(false)
      }
    },
    [loadProviders]
  )

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

  /**
   * Switch the profile the window reads. Nothing is moved: the other directory simply becomes the
   * source, and pi is restarted on it.
   */
  const changeProfile = useCallback(
    async (next: 'shared' | 'desktop') => {
      try {
        const result = await window.pi.setProfile(next)
        if (!result.ok) {
          setError(result.error ?? '切换失败')
          return
        }
        setNotice(
          next === 'desktop'
            ? `已切到独立配置：${result.profileDir ?? ''}（需要登录服务商，或从 CLI 导入）`
            : '已切回 pi CLI 的配置'
        )
        await loadSettings()
        await loadProviders()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [loadProviders, loadSettings]
  )

  /** Copy the CLI's auth/models/settings/mcp into the desktop profile, filling only gaps. */
  const importCli = useCallback(async () => {
    try {
      const result = await window.pi.importCliConfig()
      if (!result.ok) {
        setError(result.error ?? '导入失败')
        return
      }
      setNotice(
        result.copied && result.copied.length > 0
          ? `已从 CLI 导入：${result.copied.join('、')}`
          : '没有可导入的文件（已存在的不覆盖）'
      )
      await loadSettings()
      await loadProviders()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [loadProviders, loadSettings])

  /**
   * Turn auto-compaction on or off. Enabling also makes the main process write the reserve that
   * puts the trigger at `AUTO_COMPACT_RATIO` of the current model's window, then restart pi.
   */
  const toggleAutoCompact = useCallback(
    async (enabled: boolean) => {
      try {
        const result = await window.pi.setAutoCompact(enabled)
        if (!result.ok) {
          setError(result.error ?? '设置失败')
          return
        }
        setNotice(
          !enabled
            ? '自动压缩已关闭'
            : result.warning
              ? result.warning
              : `自动压缩已开启：到 ${result.percent ?? status.autoCompactPercent ?? 90}% 时压缩（保留 ${formatTokens(
                  result.reserveTokens ?? 0
                )} tokens）`
        )
        await loadSettings()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [loadSettings, status.autoCompactPercent]
  )

  const loadModelsJson = useCallback(async () => {
    const file = await window.pi.getModelsJson()
    setModelsJson(file)
    setModelsContent(file.content)
    setModelsDirty(false)
  }, [])

  /**
   * Set the auto-compaction trigger (percentage of the model's window).
   *
   * The main process stores it as a ratio, so switching to a model with a different window keeps
   * the same proportion and recomputes pi's `reserveTokens`. While a run is in flight the restart is
   * deferred, so the value shows up in `/autocompact` and the meter immediately and pi picks it up
   * when the current turn settles.
   */
  const applyCompactPercent = useCallback(
    async (value: number) => {
      setCompactBusy(true)
      try {
        const result = await window.pi.setAutoCompactRatio(value)
        if (!result.ok) {
          setError(result.error ?? '设置失败')
          return
        }
        setNotice(
          result.warning ??
            `自动压缩阈值：${result.percent ?? value}%（当前模型保留 ${formatTokens(
              result.reserveTokens ?? 0
            )} tokens）`
        )
        await loadSettings()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setCompactBusy(false)
      }
    },
    [loadSettings]
  )

  // Broadcasts carry the effective threshold, so the select follows `/autocompact 500000` too.
  useEffect(() => {
    if (typeof status.autoCompactPercent === 'number') {
      setCompactPercent(String(status.autoCompactPercent))
    }
  }, [status.autoCompactPercent])

  useEffect(() => {
    if (!open) return
    setTab(initialTab ?? 'providers')
    setNotice(undefined)
    setError(undefined)
    void loadProviders()
    void loadSettings()
    // The per-provider "联网" switch lives on the MCP engine's config, so read it here.
    void window.pi
      .getMcpState()
      .then((state) => setWebSearch(state.web))
      .catch(() => undefined)
  }, [open, initialTab, loadProviders, loadSettings])

  useEffect(() => {
    if (!open) return
    return window.pi.onMcpState((state) => setWebSearch(state.web))
  }, [open])

  const toggleProviderWebSearch = useCallback(
    async (provider: ProviderInfo, enabled: boolean) => {
      setWebBusy(true)
      try {
        const next = await window.pi.setProviderWebSearch(provider.id, enabled)
        setWebSearch(next.web)
        setNotice(
          enabled
            ? `${provider.name} 的原生搜索已开启（web_search 会优先用它）`
            : `${provider.name} 的原生搜索已关闭（web_search 回退 Brave）`
        )
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setWebBusy(false)
      }
    },
    []
  )

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

  /** Common trigger points, plus whatever `/autocompact <tokens>` happened to produce. */
  const compactOptions = useMemo(() => {
    const values = [...COMPACT_PERCENT_PRESETS]
    const current = Number(compactPercent)
    if (Number.isFinite(current) && current > 0 && !values.includes(current)) {
      values.push(current)
      values.sort((a, b) => a - b)
    }
    return values
  }, [compactPercent])

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

  const changeEngine = useCallback(async (engine: 'pi' | 'prophey') => {
    const next = await window.pi.setEngine(engine)
    if (next.phase === 'error') {
      setError(next.error ?? '切换引擎失败')
      return
    }
    setDesktopConfig(await window.pi.getDesktopConfig())
    setNotice(
      engine === 'prophey'
        ? '已切换到 Prophey 引擎（自带循环与工具；压缩、子代理、/btw 还不支持）'
        : '已切换到 pi 引擎'
    )
  }, [])

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
      <div className="settings" ref={dialogRef} style={dialogStyle}>
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
          <button className={tab === 'agents' ? 'active' : ''} onClick={() => setTab('agents')}>
            <SparkIcon size={15} /> 代理
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
                      : tab === 'agents'
                        ? '代理'
                        : '通用'}
              </h2>
              <p>
                {tab === 'providers'
                  ? '使用 pi 内置的 OAuth 或 API Key 登录，凭据保存到 ~/.pi/agent/auth.json'
                  : tab === 'custom'
                    ? '通过 models.json 配置 OpenAI 兼容端点、baseUrl 与模型列表'
                    : tab === 'mcp'
                      ? 'MCP 总开关、桌面提问工具与 ~/.pi/agent/mcp.json 里的服务器'
                      : tab === 'agents'
                        ? '子代理预设：注入哪些工具、追加什么提示词，以及如何暴露给模型'
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
                  <Fragment key={provider.id}>
                  <div
                    className={`provider-row ${provider.configured ? 'configured' : ''}`}
                  >
                    <ProviderMark id={provider.id} name={provider.name} />
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
                        {provider.baseUrl && (
                          <span className="provider-base-url-tag" title={provider.baseUrl}>
                            <PlugIcon size={10} />
                            {provider.baseUrl}
                          </span>
                        )}
                      </div>
                      {PROVIDER_NOTES[provider.id] && (
                        <div className="provider-note">{PROVIDER_NOTES[provider.id]}</div>
                      )}
                    </div>
                    <div className="provider-actions">
                      {webSearch !== undefined &&
                        webSearch.nativeSupported.includes(provider.id) && (
                        <button
                          className={`prov-btn ghost web ${
                            webSearch.nativeProviders.includes(provider.id) ? 'on' : ''
                          }`}
                          disabled={webBusy}
                          onClick={() =>
                            void toggleProviderWebSearch(
                              provider,
                              !webSearch.nativeProviders.includes(provider.id)
                            )
                          }
                          title={
                            webSearch.nativeProviders.includes(provider.id)
                              ? 'web_search 优先用该服务商的原生搜索；点击改为回退 Brave'
                              : '让 web_search 用该服务商自己的原生搜索（需要已登录 / 有 Key）'
                          }
                        >
                          <GlobeIcon size={12} />
                          {webSearch.nativeProviders.includes(provider.id) ? '联网 开' : '联网'}
                        </button>
                      )}
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
                      {provider.baseUrlEditable && (
                        <button
                          className={`prov-btn ghost ${provider.baseUrl ? 'on' : ''}`}
                          onClick={() => {
                            setBaseUrlEdit(baseUrlEdit === provider.id ? undefined : provider.id)
                            setBaseUrlDraft(provider.baseUrl ?? '')
                          }}
                          title="自定义接口地址（写入 models.json 的 providers.<id>.baseUrl，重启后生效）"
                        >
                          <PlugIcon size={12} /> 地址
                        </button>
                      )}
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
                  {baseUrlEdit === provider.id && (
                    <div className="provider-base-url">
                      <input
                        autoFocus
                        value={baseUrlDraft}
                        spellCheck={false}
                        placeholder={BASE_URL_PLACEHOLDER[provider.id] ?? 'https://'}
                        onChange={(event) => setBaseUrlDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void saveBaseUrl(provider, baseUrlDraft)
                          if (event.key === 'Escape') setBaseUrlEdit(undefined)
                        }}
                      />
                      <button
                        className="prov-btn"
                        disabled={baseUrlBusy || !baseUrlDraft.trim()}
                        onClick={() => void saveBaseUrl(provider, baseUrlDraft)}
                      >
                        保存
                      </button>
                      <button
                        className="prov-btn ghost"
                        disabled={baseUrlBusy || !provider.baseUrl}
                        onClick={() => void saveBaseUrl(provider, null)}
                      >
                        用默认
                      </button>
                      <button className="prov-btn ghost" onClick={() => setBaseUrlEdit(undefined)}>
                        取消
                      </button>
                      <span className="provider-base-url-hint">
                        默认 {BASE_URL_PLACEHOLDER[provider.id] ?? '—'}；填代理或镜像地址，留空即恢复默认
                      </span>
                    </div>
                  )}
                  </Fragment>
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

          {tab === 'agents' && <AgentsPanel onNotice={setNotice} onError={setError} />}

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
                <label>配置来源</label>
                <div className="theme-switch storage-switch">
                  <button
                    className={desktopConfig?.profile !== 'desktop' ? 'active' : ''}
                    onClick={() => void changeProfile('shared')}
                  >
                    共用 pi
                  </button>
                  <button
                    className={desktopConfig?.profile === 'desktop' ? 'active' : ''}
                    onClick={() => void changeProfile('desktop')}
                  >
                    独立配置
                  </button>
                </div>
                <p className="field-hint">
                  共用：<code>{desktopConfig?.cliDir ?? '~/.pi/agent'}</code>
                  ，与 pi CLI 读写同一份 auth.json / models.json / settings.json / mcp.json。
                </p>
                <p className="field-hint">
                  独立：<code>{desktopConfig?.profileDir ?? '应用数据目录/pi'}</code>
                  ，桌面端自己的凭据与模型；CLI 里登录、改配置都不会影响它，也不会被它影响。
                </p>
                {desktopConfig?.profile === 'desktop' && (
                  <div className="field-row">
                    <button className="ghost" onClick={() => void importCli()}>
                      <RefreshIcon size={12} /> 从 CLI 导入配置
                    </button>
                    <span className="field-inline">只补缺失文件，不覆盖已有配置</span>
                  </div>
                )}
              </div>

              <div className="field">
                <label>引擎</label>
                <div className="theme-switch storage-switch">
                  <button
                    className={desktopConfig?.engine === 'pi' ? 'active' : ''}
                    onClick={() => void changeEngine('pi')}
                  >
                    pi
                  </button>
                  <button
                    className={desktopConfig?.engine !== 'pi' ? 'active' : ''}
                    onClick={() => void changeEngine('prophey')}
                  >
                    Prophey
                  </button>
                </div>
                <p className="field-hint">
                  pi：完整的编码 agent（工具、压缩、子代理、扩展、<code>/btw</code>）。
                </p>
                <p className="field-hint">
                  Prophey（默认）：我们自己的循环——直连服务商、根感知工具、MCP、子代理、
                  <code>/btw</code>、压缩与重试、自己的 transcript 与系统提示词。
                  只差 Claude 的快速模式。
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
                <label>默认自动压缩</label>
                <div className="field-row">
                  <Toggle
                    checked={settings?.compaction?.enabled !== false}
                    onChange={(enabled) => void toggleAutoCompact(enabled)}
                  />
                  <span className="field-inline">
                    {settings?.compaction?.enabled === false
                      ? '已关闭：上下文满了会直接报错'
                      : `到 ${compactPercent || status.autoCompactPercent || 90}% 时自动压缩`}
                  </span>
                </div>
                <p className="field-hint">
                  全局默认，对所有会话生效（包括新会话）。阈值按当前模型的上下文窗口换算成 pi 的{' '}
                  <code>reserveTokens</code>，按比例保存，换模型时会重新计算。没有窗口信息的自定义模型请先补上
                  <code>contextWindow</code>。
                </p>
              </div>

              <div className="field">
                <label>默认自动压缩阈值</label>
                <select
                  value={compactPercent || String(status.autoCompactPercent ?? 90)}
                  disabled={compactBusy || settings?.compaction?.enabled === false}
                  onChange={(event) => {
                    const next = Number(event.target.value)
                    setCompactPercent(String(next))
                    void applyCompactPercent(next)
                  }}
                >
                  {compactOptions.map((percent) => (
                    <option key={percent} value={percent}>
                      窗口的 {percent}%
                    </option>
                  ))}
                </select>
                <p className="field-hint">
                  {status.model?.contextWindow
                    ? `当前模型窗口 ${formatTokens(status.model.contextWindow)}，到约 ${formatTokens(
                        Math.round(
                          ((Number(compactPercent) || status.autoCompactPercent || 90) / 100) *
                            status.model.contextWindow
                        )
                      )} tokens 时压缩；剩下的余量留给下一轮回复。`
                    : '当前模型没有上下文窗口信息，切到有窗口的模型后自动换算。'}
                  正在运行时可改，pi 会在本轮结束后重启生效；也能用{' '}
                  <code>/autocompact 500000</code> 按 token 数设置。
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
