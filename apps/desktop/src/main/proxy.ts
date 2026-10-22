import { session } from 'electron'
import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'
import type { ProxyInfo } from '../shared/types'

let currentProxy: string | null = null
let currentSource: 'system' | 'none' = 'none'

export function getProxyInfo(): ProxyInfo {
  return { proxy: currentProxy, source: currentSource }
}

export async function applySystemProxy(): Promise<ProxyInfo> {
  let resolved = 'DIRECT'
  try {
    resolved = await session.defaultSession.resolveProxy('https://api.github.com')
  } catch {
    // fall back to direct
  }
  const match = /PROXY\s+([^\s;]+)/i.exec(resolved)
  const proxy = match ? `http://${match[1]}` : null
  if (proxy !== currentProxy) {
    currentProxy = proxy
    currentSource = proxy ? 'system' : 'none'
    if (proxy) {
      process.env.HTTP_PROXY = proxy
      process.env.HTTPS_PROXY = proxy
      process.env.ALL_PROXY = proxy
      process.env.NO_PROXY = 'localhost,127.0.0.1,::1'
      process.env.NODE_USE_ENV_PROXY = '1'
      setGlobalDispatcher(new EnvHttpProxyAgent())
    } else {
      delete process.env.HTTP_PROXY
      delete process.env.HTTPS_PROXY
      delete process.env.ALL_PROXY
      delete process.env.NO_PROXY
      delete process.env.NODE_USE_ENV_PROXY
      setGlobalDispatcher(new Agent())
    }
  }
  return getProxyInfo()
}
