#!/usr/bin/env node
/**
 * Agent Desktop core interaction MCP server (stdio JSON-RPC, zero dependencies).
 *
 * Exposes the desktop tools of `tools/index.mjs` to pi. The desktop app starts this server through
 * its extension (`--extension`) and passes the bridge URL/token in the environment, so nothing is
 * written to `~/.pi/agent/mcp.json` and terminal pi sessions stay untouched.
 *
 * Requests are held until the user answers: there is no application-side timeout anywhere. The only
 * ways out are the user answering, the MCP client cancelling (`notifications/cancelled`), pi
 * restarting, or the window closing.
 */
import http from 'node:http'
import process from 'node:process'
import { tools } from './tools/index.mjs'

const BRIDGE_URL = process.env.AGENT_DESKTOP_MCP_URL ?? ''
const BRIDGE_TOKEN = process.env.AGENT_DESKTOP_MCP_TOKEN ?? ''
const SERVER_NAME = 'agent-desktop-core'
const SERVER_VERSION = '0.2.0'
const FALLBACK_PROTOCOL = '2025-06-18'
const KNOWN_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

function log(message) {
  process.stderr.write(`[desktop-core] ${message}\n`)
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function post(path, payload, signal) {
  return new Promise((resolve, reject) => {
    if (!BRIDGE_URL) {
      reject(new Error('Agent Desktop 桥接地址未配置（AGENT_DESKTOP_MCP_URL）'))
      return
    }
    let target
    try {
      target = new URL(path, BRIDGE_URL)
    } catch (error) {
      reject(new Error(`桥接地址无效：${error.message}`))
      return
    }
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    const request = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': body.length,
          'x-agent-desktop-token': BRIDGE_TOKEN
        }
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (response.statusCode !== 200) {
            reject(new Error(`桥接返回 ${response.statusCode}：${text.slice(0, 400)}`))
            return
          }
          try {
            resolve(JSON.parse(text))
          } catch {
            reject(new Error(`桥接返回了无法解析的内容：${text.slice(0, 400)}`))
          }
        })
      }
    )
    // Never time out: the bridge holds the request until the user answers.
    request.setTimeout(0)
    request.on('error', (error) => reject(error))
    if (signal) {
      if (signal.aborted) request.destroy(new Error('请求已取消'))
      else signal.addEventListener('abort', () => request.destroy(new Error('请求已取消')), { once: true })
    }
    request.end(body)
  })
}

const toolByName = new Map(tools.map((tool) => [tool.name, tool]))
const inflight = new Map()

async function handleRequest(message) {
  const { id, method, params } = message
  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion
      reply(id, {
        protocolVersion: KNOWN_PROTOCOLS.includes(requested) ? requested : FALLBACK_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          'Desktop interaction tools. `ask_user_question` asks the user in the Agent Desktop window: ' +
          'use it when the answer changes what you build (ambiguous requirements, a real tradeoff, ' +
          'information only the user has), not for decisions you can settle from the code. ' +
          'Offer 2-4 concrete options; the user can always type their own answer.'
      })
      return
    }
    case 'ping':
      reply(id, {})
      return
    case 'tools/list':
      reply(id, {
        tools: tools.map(({ name, title, description, inputSchema }) => ({
          name,
          title,
          description,
          inputSchema
        }))
      })
      return
    case 'tools/call': {
      const tool = toolByName.get(params?.name)
      if (!tool) {
        replyError(id, -32602, `unknown tool: ${String(params?.name)}`)
        return
      }
      const controller = new AbortController()
      if (id !== undefined) inflight.set(id, controller)
      try {
        reply(
          id,
          await tool.call(params?.arguments, {
            post,
            signal: controller.signal,
            log
          })
        )
      } finally {
        if (id !== undefined) inflight.delete(id)
      }
      return
    }
    case 'resources/list':
      reply(id, { resources: [] })
      return
    case 'resources/templates/list':
      reply(id, { resourceTemplates: [] })
      return
    case 'prompts/list':
      reply(id, { prompts: [] })
      return
    default:
      replyError(id, -32601, `method not supported: ${String(method)}`)
  }
}

function handleNotification(message) {
  if (message.method === 'notifications/cancelled') {
    const requestId = message.params?.requestId
    const controller = inflight.get(requestId)
    if (controller) {
      controller.abort()
      inflight.delete(requestId)
    }
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index !== -1) {
    const line = buffer.slice(0, index).replace(/\r$/, '')
    buffer = buffer.slice(index + 1)
    if (line.trim()) dispatch(line)
    index = buffer.indexOf('\n')
  }
})

function dispatch(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    log(`invalid JSON: ${line.slice(0, 200)}`)
    return
  }
  if (!message || typeof message !== 'object') return
  if (message.id === undefined || message.id === null) {
    handleNotification(message)
    return
  }
  void handleRequest(message).catch((error) => {
    log(`request failed: ${error instanceof Error ? error.stack : String(error)}`)
    replyError(message.id, -32603, error instanceof Error ? error.message : String(error))
  })
}

process.stdin.on('end', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
log(`ready (tools=${tools.map((tool) => tool.name).join(',')} bridge=${BRIDGE_URL || 'unset'})`)
