import { randomUUID } from 'node:crypto'
import http from 'node:http'
import type { AskAnswer, AskQuestion, AskRequest, AskResult, BridgeInfo } from '../shared/types'

const MAX_BODY_BYTES = 512 * 1024
const PORT_ATTEMPTS = 12

interface PendingAsk {
  resolve: (result: AskResult) => void
}

let server: http.Server | null = null
let port = 0
let token = ''
let askListener: ((request: AskRequest) => void) | null = null
const pending = new Map<string, PendingAsk>()

export function getBridgeInfo(): BridgeInfo {
  return {
    running: Boolean(server),
    url: port ? `http://127.0.0.1:${port}` : '',
    port,
    pending: pending.size
  }
}

export function getBridgeUrl(): string {
  return port ? `http://127.0.0.1:${port}` : ''
}

export function getBridgeToken(): string {
  return token
}

export function setAskListener(listener: ((request: AskRequest) => void) | null): void {
  askListener = listener
}

export function answerAsk(id: string, answers: AskAnswer[]): void {
  const entry = pending.get(id)
  if (!entry) return
  pending.delete(id)
  entry.resolve({ answers })
}

export function cancelAsk(id: string, reason?: string): void {
  const entry = pending.get(id)
  if (!entry) return
  pending.delete(id)
  entry.resolve({ cancelled: true, reason })
}

export function cancelAllAsks(reason: string): void {
  for (const id of [...pending.keys()]) cancelAsk(id, reason)
}

function normalizeQuestions(raw: unknown): AskQuestion[] {
  if (!Array.isArray(raw)) return []
  const questions: AskQuestion[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const value = entry as Record<string, unknown>
    if (typeof value.question !== 'string' || !value.question.trim()) continue
    const options = Array.isArray(value.options)
      ? value.options
          .map((option) => {
            if (!option || typeof option !== 'object') return null
            const item = option as Record<string, unknown>
            if (typeof item.label !== 'string' || !item.label.trim()) return null
            return {
              label: item.label.trim(),
              ...(typeof item.description === 'string' && item.description.trim()
                ? { description: item.description.trim() }
                : {})
            }
          })
          .filter((option): option is { label: string; description?: string } => option !== null)
      : []
    questions.push({
      question: value.question.trim(),
      ...(typeof value.header === 'string' && value.header.trim()
        ? { header: value.header.trim() }
        : {}),
      ...(value.multiSelect === true ? { multiSelect: true } : {}),
      ...(options.length > 0 ? { options } : {})
    })
  }
  return questions
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function respond(response: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  })
  response.end(body)
}

async function handleAsk(
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<void> {
  if (token && request.headers['x-agent-desktop-token'] !== token) {
    respond(response, 401, { cancelled: true, reason: '桥接令牌无效' })
    return
  }
  if (!askListener) {
    respond(response, 503, { cancelled: true, reason: '桌面窗口尚未就绪' })
    return
  }
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(await readBody(request)) as Record<string, unknown>
  } catch (error) {
    respond(response, 400, {
      cancelled: true,
      reason: `请求解析失败：${error instanceof Error ? error.message : String(error)}`
    })
    return
  }
  const questions = normalizeQuestions(payload.questions)
  if (questions.length === 0) {
    respond(response, 400, { cancelled: true, reason: '没有可提问的问题' })
    return
  }

  const id = randomUUID()
  const ask: AskRequest = {
    id,
    questions,
    createdAt: Date.now(),
    tool: typeof payload.tool === 'string' ? payload.tool : undefined
  }

  // No timeout: the tool waits until the user answers, the run is aborted, or the app closes.
  const result = await new Promise<AskResult>((resolve) => {
    pending.set(id, { resolve })
    askListener?.(ask)
  })

  if (result.cancelled) respond(response, 200, { cancelled: true, reason: result.reason })
  else respond(response, 200, { answers: result.answers })
}

function createHandler(): http.RequestListener {
  return (request, response) => {
    const url = request.url ?? '/'
    if (request.method === 'GET' && url === '/health') {
      respond(response, 200, { ok: true, pending: pending.size })
      return
    }
    if (request.method === 'POST' && url === '/ask') {
      void handleAsk(request, response).catch((error: unknown) => {
        respond(response, 500, {
          cancelled: true,
          reason: error instanceof Error ? error.message : String(error)
        })
      })
      return
    }
    respond(response, 404, { error: 'not found' })
  }
}

function listenOn(candidate: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const next = http.createServer(createHandler())
    // A pending question can stay unanswered for a long time; never cut the socket or request.
    next.requestTimeout = 0
    next.timeout = 0
    const onError = (error: NodeJS.ErrnoException): void => {
      next.removeListener('listening', onListening)
      next.close()
      reject(error)
    }
    const onListening = (): void => {
      next.removeListener('error', onError)
      next.on('error', (error) => console.warn('[bridge] server error:', error.message))
      resolve(next)
    }
    next.once('error', onError)
    next.once('listening', onListening)
    next.listen(candidate, '127.0.0.1')
  })
}

export async function startBridge(options: {
  preferredPort?: number
  token: string
}): Promise<{ url: string; port: number }> {
  token = options.token
  if (server) {
    const address = server.address()
    return { url: getBridgeUrl(), port: typeof address === 'object' && address ? address.port : port }
  }
  const preferred = options.preferredPort && options.preferredPort > 0 ? options.preferredPort : 0
  const candidates =
    preferred > 0
      ? [preferred, ...Array.from({ length: PORT_ATTEMPTS }, (_, index) => preferred + index + 1)]
      : [0]
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      const started = await listenOn(candidate)
      server = started
      const address = started.address()
      port = typeof address === 'object' && address ? address.port : candidate
      console.log(`[bridge] listening on ${getBridgeUrl()}`)
      return { url: getBridgeUrl(), port }
    } catch (error) {
      lastError = error
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') break
    }
  }
  throw new Error(
    `无法启动桌面桥接服务：${lastError instanceof Error ? lastError.message : String(lastError)}`
  )
}

export function stopBridge(): void {
  cancelAllAsks('桌面端已关闭')
  server?.close()
  server = null
  port = 0
}
