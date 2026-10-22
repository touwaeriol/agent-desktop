#!/usr/bin/env node
import http from 'node:http'
import process from 'node:process'

const BRIDGE_URL = process.env.AGENT_DESKTOP_MCP_URL ?? ''
const BRIDGE_TOKEN = process.env.AGENT_DESKTOP_MCP_TOKEN ?? ''
const SERVER_NAME = 'agent-desktop-ask-user'
const SERVER_VERSION = '0.1.0'
const FALLBACK_PROTOCOL = '2025-06-18'
const KNOWN_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const MAX_OPTIONS = 8
const MAX_QUESTIONS = 6

const TOOL = {
  name: 'ask_user_question',
  title: 'Ask the user a question',
  description:
    'Ask the user one or more questions in the Agent Desktop app and wait for the answer. ' +
    'Each question supports single choice, multiple choice (multiSelect: true), and free-form input ' +
    'the user can type themselves. Questions are shown one at a time, in order. ' +
    'Use this when you need a decision, a preference, or missing information before continuing.',
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_QUESTIONS,
        description: 'Questions to ask, answered in order.',
        items: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: 'The full question text shown to the user.'
            },
            header: {
              type: 'string',
              description: 'Short label (a few words) shown above the question.'
            },
            multiSelect: {
              type: 'boolean',
              description: 'Allow selecting more than one option. Defaults to false.'
            },
            options: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_OPTIONS,
              description: 'Choices offered to the user. The user can always type their own answer.',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'Short choice text.' },
                  description: { type: 'string', description: 'Optional explanation of the choice.' }
                },
                required: ['label'],
                additionalProperties: false
              }
            }
          },
          required: ['question'],
          additionalProperties: false
        }
      }
    },
    required: ['questions'],
    additionalProperties: false
  }
}

function log(message) {
  process.stderr.write(`[ask-user] ${message}\n`)
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

function normalizeQuestions(args) {
  const raw = Array.isArray(args?.questions)
    ? args.questions
    : typeof args?.question === 'string'
      ? [{ question: args.question, options: args.options, multiSelect: args.multiSelect }]
      : []
  const questions = []
  for (const entry of raw.slice(0, MAX_QUESTIONS)) {
    if (!entry || typeof entry.question !== 'string' || !entry.question.trim()) continue
    const options = Array.isArray(entry.options)
      ? entry.options
          .filter((option) => option && typeof option.label === 'string' && option.label.trim())
          .slice(0, MAX_OPTIONS)
          .map((option) => ({
            label: option.label.trim(),
            ...(typeof option.description === 'string' && option.description.trim()
              ? { description: option.description.trim() }
              : {})
          }))
      : []
    questions.push({
      question: entry.question.trim(),
      ...(typeof entry.header === 'string' && entry.header.trim()
        ? { header: entry.header.trim() }
        : {}),
      ...(entry.multiSelect === true ? { multiSelect: true } : {}),
      ...(options.length > 0 ? { options } : {})
    })
  }
  return questions
}

function postBridge(payload, signal) {
  return new Promise((resolve, reject) => {
    if (!BRIDGE_URL) {
      reject(new Error('Agent Desktop 桥接地址未配置（AGENT_DESKTOP_MCP_URL）'))
      return
    }
    let target
    try {
      target = new URL('/ask', BRIDGE_URL)
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
    request.setTimeout(0)
    request.on('error', (error) => reject(error))
    if (signal) {
      if (signal.aborted) request.destroy(new Error('请求已取消'))
      else signal.addEventListener('abort', () => request.destroy(new Error('请求已取消')), { once: true })
    }
    request.end(body)
  })
}

function formatAnswers(answers) {
  const lines = []
  answers.forEach((answer, index) => {
    const tag = answer.header ? `[${answer.header}] ` : ''
    lines.push(`${index + 1}. ${tag}${answer.question}`)
    if (answer.skipped) {
      lines.push('   → （用户跳过）')
      return
    }
    if (Array.isArray(answer.selected) && answer.selected.length > 0) {
      lines.push(`   → ${answer.selected.join('、')}`)
    }
    if (answer.other) lines.push(`   补充：${answer.other}`)
    if ((!answer.selected || answer.selected.length === 0) && !answer.other) {
      lines.push('   → （用户未填写）')
    }
  })
  return lines.join('\n')
}

async function callTool(args, signal) {
  const questions = normalizeQuestions(args)
  if (questions.length === 0) {
    return {
      content: [{ type: 'text', text: 'ask_user_question 需要至少一个问题。' }],
      isError: true
    }
  }
  let result
  try {
    result = await postBridge({ tool: TOOL.name, questions }, signal)
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `无法在桌面端提问：${error instanceof Error ? error.message : String(error)}`
        }
      ],
      isError: true
    }
  }
  if (!result || result.cancelled) {
    return {
      content: [
        {
          type: 'text',
          text: `用户取消了这次提问，没有提供答案${result?.reason ? `（${result.reason}）` : ''}。请据此决定下一步，不要假设答案。`
        }
      ]
    }
  }
  const answers = Array.isArray(result.answers) ? result.answers : []
  return {
    content: [
      {
        type: 'text',
        text: `用户已回答 ${answers.filter((answer) => !answer.skipped).length}/${answers.length} 个问题：\n${formatAnswers(answers)}`
      },
      { type: 'text', text: JSON.stringify({ answers }, null, 2) }
    ],
    structuredContent: { answers }
  }
}

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
          'Use ask_user_question when you need a decision or missing detail from the user. ' +
          'Prefer 2-4 concrete options per question; the user can always type their own answer.'
      })
      return
    }
    case 'ping':
      reply(id, {})
      return
    case 'tools/list':
      reply(id, { tools: [TOOL] })
      return
    case 'tools/call': {
      const name = params?.name
      if (name !== TOOL.name) {
        replyError(id, -32602, `unknown tool: ${String(name)}`)
        return
      }
      const controller = new AbortController()
      if (id !== undefined) inflight.set(id, controller)
      try {
        reply(id, await callTool(params?.arguments, controller.signal))
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
log(`ready (bridge=${BRIDGE_URL || 'unset'})`)
