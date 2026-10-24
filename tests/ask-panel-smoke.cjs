/**
 * Drives the real question panel in the smoke window through the loopback bridge, so the engine ask
 * path (bridge → `ask:request` → panel → `ask:answer`) is exercised end to end, including the
 * Codex-shaped fields (`tool`, `secret`, per-question options) and cancellation.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

function postAsk(port, token, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/ask',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-agent-desktop-token': token
        }
      },
      (response) => {
        let raw = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => (raw += chunk))
        response.on('end', () => {
          try {
            resolve(JSON.parse(raw))
          } catch (error) {
            reject(error)
          }
        })
      }
    )
    request.on('error', reject)
    request.end(body)
  })
}

module.exports = async function askPanelSmoke(evaluate, until) {
  const config = JSON.parse(
    fs.readFileSync(path.join(process.env.PROPHEY_SMOKE_DATA, 'config.json'), 'utf8')
  )
  const port = config.mcp?.bridgePort
  const token = config.mcp?.bridgeToken
  assert(port && token, 'the bridge must publish its port and token for the engines')

  const answered = postAsk(port, token, {
    tool: 'Codex',
    questions: [
      {
        header: '输出语言',
        question: '用哪种语言回答？',
        options: [{ label: '中文', description: '中文回答' }, { label: '英文' }]
      },
      { header: '访问令牌', question: '请粘贴访问令牌', options: [], secret: true }
    ]
  })

  await until(() => evaluate('!!document.querySelector(".ask-panel")'), 'ask panel')
  assert.match(
    await evaluate('document.querySelector(".ask-panel-title").textContent'),
    /需要你的确认[\s\S]*Codex/,
    'the panel says which tool is asking'
  )
  assert.equal(await evaluate('document.querySelectorAll(".ask-step").length'), 2)
  await evaluate(
    'Array.from(document.querySelectorAll(".ask-option")).find((button) => button.textContent.includes("英文")).click()'
  )
  await evaluate('document.querySelector(".ask-foot-actions .primary").click()')
  await until(
    () => evaluate('document.querySelector(".ask-question")?.textContent.includes("访问令牌")'),
    'second question'
  )
  assert.equal(
    await evaluate('document.querySelector(".ask-input-row input").type'),
    'password',
    'secret answers are masked while typing'
  )
  await evaluate(`
    (() => {
      const input = document.querySelector('.ask-input-row input')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, 'sk-smoke')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()
  `)
  await until(
    () => evaluate('!document.querySelector(".ask-foot-actions .primary").disabled'),
    'submit enabled'
  )
  await evaluate('document.querySelector(".ask-foot-actions .primary").click()')
  const result = await answered
  assert.deepEqual(result, {
    answers: [
      { question: '用哪种语言回答？', header: '输出语言', selected: ['英文'] },
      { question: '请粘贴访问令牌', header: '访问令牌', selected: [], other: 'sk-smoke' }
    ]
  })
  await until(() => evaluate('!document.querySelector(".ask-panel")'), 'panel dismissed after answering')

  // Closing the panel must cancel instead of leaving the engine waiting forever.
  const cancelled = postAsk(port, token, { tool: 'Bash', questions: [{ question: '允许执行？' }] })
  await until(() => evaluate('!!document.querySelector(".ask-panel")'), 'ask panel again')
  await evaluate('document.querySelector(".ask-panel-head .icon-btn").click()')
  assert.equal((await cancelled).cancelled, true)
  await until(() => evaluate('!document.querySelector(".ask-panel")'), 'panel dismissed after cancel')
  console.log('Question panel passed: tool label, options, secret masking, bridge answer and cancel')
}
