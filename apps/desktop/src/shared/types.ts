export interface PiModel {
  provider: string
  id: string
  name?: string
  contextWindow?: number
}

export interface ModelOption extends PiModel {
  providerName?: string
  reasoning?: boolean
}

export interface PiStatus {
  phase: 'starting' | 'ready' | 'error' | 'stopped'
  cwd: string
  model?: PiModel
  thinkingLevel?: string
  sessionName?: string
  sessionFile?: string
  isStreaming?: boolean
  error?: string
  stderrTail?: string
}

export interface SessionSummary {
  path: string
  title: string
  cwd: string
  createdAt: number
  updatedAt: number
}

export interface ContentBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  arguments?: unknown
  data?: string
  mimeType?: string
}

export interface AgentMessage {
  role: 'user' | 'assistant' | 'toolResult' | 'system' | 'custom'
  content: string | ContentBlock[]
  timestamp?: number
  provider?: string
  model?: string
  toolCallId?: string
  toolName?: string
  isError?: boolean
  stopReason?: string
}

export interface PromptImage {
  type: 'image'
  data: string
  mimeType: string
}

export interface PromptResult {
  ok: boolean
  disposition?: 'started' | 'queued' | 'handled'
  error?: string
}

export interface SwitchResult {
  ok: boolean
  error?: string
}

export type ProviderAuthType = 'api_key' | 'oauth'

export interface ProviderAuthOption {
  type: ProviderAuthType
  label: string
}

export interface ProviderInfo {
  id: string
  name: string
  modelCount: number
  options: ProviderAuthOption[]
  configured: boolean
  builtin: boolean
  source?: string
  sourceLabel?: string
  storedType?: ProviderAuthType
}

export interface LoginPromptOption {
  id: string
  label: string
  description?: string
}

export interface LoginPrompt {
  type: 'text' | 'secret' | 'select' | 'manual_code'
  message: string
  placeholder?: string
  options?: LoginPromptOption[]
}

export interface LoginInfoLink {
  url: string
  label?: string
}

export type LoginEvent =
  | { type: 'info'; message: string; links?: LoginInfoLink[] }
  | { type: 'auth_url'; url: string; instructions?: string }
  | {
      type: 'device_code'
      userCode: string
      verificationUri: string
      intervalSeconds?: number
      expiresInSeconds?: number
    }
  | { type: 'progress'; message: string }

export type LoginMessage =
  | { kind: 'prompt'; loginId: string; promptId: string; prompt: LoginPrompt }
  | { kind: 'event'; loginId: string; event: LoginEvent }
  | {
      kind: 'done'
      loginId: string
      ok: boolean
      error?: string
      credentialType?: ProviderAuthType
    }

export interface ModelsJsonFile {
  path: string
  content: string
}

export interface AppSettings {
  defaultProvider?: string
  defaultModel?: string
  defaultThinkingLevel?: string
  enabledModels: string[]
  settingsPath: string
  modelsPath: string
  authPath: string
}

export interface ProviderModelOption {
  id: string
  modelId: string
  name?: string
  contextWindow?: number
  reasoning?: boolean
  enabled: boolean
}

export interface ModelChoice {
  provider: string
  providerName: string
  id: string
  name?: string
  configured: boolean
}

export interface DesktopConfig {
  cwd: string
  sessionMode: 'shared' | 'isolated'
  sessionDir: string
  sharedSessionDir: string
  isolatedSessionDir: string
}

export type AppUpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'upToDate'
  | 'downloading'
  | 'preparing'
  | 'installing'
  | 'error'

export interface AppUpdateSnapshot {
  sequence: number
  status: AppUpdateStatus
  currentVersion: string
  latestVersion: string | null
  notes: string | null
  checkedAt: string | null
  downloaded: number
  total: number | null
  autoCheck: boolean
  canInstall: boolean
  releasesUrl: string
  error: { code: string; message: string } | null
}

export interface ProxyInfo {
  proxy: string | null
  source: 'system' | 'none'
}

export interface AskOption {
  label: string
  description?: string
}

export interface AskQuestion {
  question: string
  header?: string
  multiSelect?: boolean
  options?: AskOption[]
}

export interface AskRequest {
  id: string
  questions: AskQuestion[]
  createdAt: number
  tool?: string
}

export interface AskAnswer {
  question: string
  header?: string
  selected: string[]
  other?: string
  skipped?: boolean
}

export type AskResult =
  | { cancelled: true; reason?: string }
  | { cancelled?: false; answers: AskAnswer[] }

export interface BridgeInfo {
  running: boolean
  url: string
  port: number
  pending: number
}

export interface McpServerInfo {
  name: string
  transport: 'stdio' | 'http'
  summary: string
  enabled: boolean
  exposure?: string
  description?: string
  source: 'user' | 'project' | 'extension'
  builtin?: boolean
}

export interface McpState {
  enabled: boolean
  desktopTool: boolean
  desktopToolAvailable: boolean
  servers: McpServerInfo[]
  userConfigPath: string
  projectConfigPath: string
  bridge: BridgeInfo
}

export interface PiBridge {
  getStatus(): Promise<PiStatus>
  restart(cwd?: string): Promise<PiStatus>
  newProjectSession(cwd: string): Promise<PiStatus>
  openSession(sessionPath: string, cwd: string): Promise<PiStatus>
  getDesktopConfig(): Promise<DesktopConfig>
  setSessionMode(mode: 'shared' | 'isolated'): Promise<PiStatus>
  getUpdateSnapshot(): Promise<AppUpdateSnapshot>
  checkForUpdates(): Promise<AppUpdateSnapshot>
  installUpdate(): Promise<AppUpdateSnapshot>
  cancelUpdateDownload(): Promise<AppUpdateSnapshot>
  setAutoUpdateCheck(enabled: boolean): Promise<AppUpdateSnapshot>
  onUpdate(listener: (snapshot: AppUpdateSnapshot) => void): () => void
  getProxyInfo(): Promise<ProxyInfo>
  chooseWorkspace(): Promise<PiStatus | null>
  prompt(
    message: string,
    streamingBehavior?: 'steer' | 'followUp',
    images?: PromptImage[]
  ): Promise<PromptResult>
  abort(): Promise<void>
  newSession(): Promise<SwitchResult>
  switchSession(sessionPath: string): Promise<SwitchResult>
  getMessages(): Promise<AgentMessage[]>
  listSessions(): Promise<SessionSummary[]>
  openAgentDir(): Promise<void>
  openExternal(url: string): Promise<void>
  setTheme(theme: 'dark' | 'light'): Promise<void>
  listModels(): Promise<ModelOption[]>
  setModel(provider: string, modelId: string): Promise<{ ok: boolean; error?: string }>
  listThinkingLevels(): Promise<string[]>
  setThinkingLevel(level: string): Promise<{ ok: boolean; error?: string }>
  listProviderModels(providerId: string): Promise<ProviderModelOption[]>
  setProviderModels(providerId: string, enabledIds: string[]): Promise<{ ok: boolean; error?: string }>
  listProviders(): Promise<ProviderInfo[]>
  startLogin(
    providerId: string,
    type: ProviderAuthType,
    loginId: string
  ): Promise<{ loginId?: string; error?: string }>
  answerLogin(loginId: string, promptId: string, value: string): Promise<void>
  cancelLogin(loginId: string): Promise<void>
  logoutProvider(providerId: string): Promise<{ ok: boolean; error?: string }>
  onLoginMessage(listener: (message: LoginMessage) => void): () => void
  getModelsJson(): Promise<ModelsJsonFile>
  saveModelsJson(content: string): Promise<{ ok: boolean; error?: string }>
  openModelsJson(): Promise<void>
  getAppSettings(): Promise<AppSettings>
  saveAppSettings(
    patch: Partial<Pick<AppSettings, 'defaultProvider' | 'defaultModel' | 'defaultThinkingLevel'>>
  ): Promise<{ ok: boolean; error?: string }>
  listModelChoices(): Promise<ModelChoice[]>
  getMcpState(): Promise<McpState>
  setMcpEnabled(enabled: boolean): Promise<McpState>
  setDesktopToolEnabled(enabled: boolean): Promise<McpState>
  setMcpServerEnabled(name: string, enabled: boolean): Promise<{ ok: boolean; error?: string }>
  removeMcpServer(name: string): Promise<{ ok: boolean; error?: string }>
  addMcpServer(name: string, config: string): Promise<{ ok: boolean; error?: string }>
  openMcpConfig(which: 'user' | 'project'): Promise<void>
  onAskRequest(listener: (request: AskRequest) => void): () => void
  onAskCleared(listener: () => void): () => void
  answerQuestion(id: string, answers: AskAnswer[]): Promise<void>
  cancelQuestion(id: string, reason?: string): Promise<void>
  onEvent(listener: (record: Record<string, unknown>) => void): () => void
  onStatus(listener: (status: PiStatus) => void): () => void
}
