/** Optional --native exercises installed CC/Codex against local mock model servers. */
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const assert = require('node:assert/strict')
const { messages } = require('../tests/history-fixture.cjs')
const root = path.resolve(__dirname, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-handoff-'))
const workspace = path.join(temporary, 'workspace'), data = path.join(temporary, 'user-data')
const native = process.argv.includes('--native')
for (const dir of [workspace, data, path.join(data, 'transcripts'), path.join(temporary, 'codex'), path.join(temporary, 'claude')]) fs.mkdirSync(dir, { recursive: true })
const source = path.join(data, 'transcripts', 's_source.jsonl')
fs.writeFileSync(source, [JSON.stringify({ type: 'header', sessionId: 's_source', workspace: { primary: workspace, additional: [] } }), ...messages.map(message => JSON.stringify({ message }))].join('\n') + '\n')
const second = path.join(data, 'transcripts', 's_second.jsonl')
fs.writeFileSync(second, [JSON.stringify({ type: 'header', sessionId: 's_second', workspace: { primary: workspace, additional: [] } }), JSON.stringify({ message: { role: 'user', content: 'SECOND_SESSION_SENTINEL' } })].join('\n') + '\n')
fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify({ sessions: [
  { id: 'primary', path: source, engine: 'prophey', cwd: workspace, additional: [], title: 'PRIMARY SESSION', createdAt: 1, updatedAt: 2 },
  { id: 'second', path: second, engine: 'prophey', cwd: workspace, additional: [], title: 'SECOND SESSION', createdAt: 1, updatedAt: 1 }
] }))
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ engine: 'prophey', propheySessionId: 's_source', engineSessions: { prophey: source }, profile: 'desktop', cwd: workspace, mcp: { enabled: false, subagents: { enabled: false } } }))
fs.writeFileSync(path.join(data, 'updates.json'), '{"autoCheck":false}')
fs.writeFileSync(path.join(temporary, 'requests.json'), '[]')
const requests = []
const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    const body = JSON.parse(raw || '{}')
    const input = body.messages ?? body.input ?? []
    const last = input.findLast(item => item.role === 'user')
    const hold = JSON.stringify(last).includes('__HOLD__')
    const counted = req.url.includes('count_tokens')
    requests.push({ kind: body.messages ? 'claude' : 'codex', counted, hold, body })
    fs.writeFileSync(path.join(temporary, 'requests.json'), JSON.stringify(requests))
    if (counted) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":120}'); return }
    if (hold) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); return }
    const id = 'proof_' + requests.length
    const text = 'Native fixture reply preserves ORCHID-731.'
    const message = { id: 'msg_' + id, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }
    const response = { id: 'resp_' + id, object: 'response', status: 'completed', model: 'gpt-5.4', output: [message], usage: { input_tokens: 120, output_tokens: 4, total_tokens: 124, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }
    const events = body.messages ? [
      { type: 'message_start', message: { id: 'msg_' + id, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
      { type: 'message_stop' }
    ] : [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: text },
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.completed', response }
    ]
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of events) res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n')
    res.end()
  })
})
async function run(phase, port) {
  const env = { ...process.env, PROPHEY_HANDOFF_ROOT: root, PROPHEY_HANDOFF_TEMP: temporary,
    PI_CODING_AGENT_DIR: path.join(data, 'pi'),
    PROPHEY_HANDOFF_NATIVE: native ? '1' : '', PROPHEY_HANDOFF_PHASE: String(phase),
    CODEX_HOME: path.join(temporary, 'codex'), CLAUDE_CONFIG_DIR: path.join(temporary, 'claude'),
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + port, ANTHROPIC_API_KEY: 'local-proof-not-a-secret',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', NO_PROXY: '127.0.0.1,localhost' }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'PI_DEBUG_PORT', 'ANTHROPIC_AUTH_TOKEN']) delete env[key]
  await new Promise((resolve, reject) => {
    let output = ''
    const child = spawn(require('electron'), [path.join(root, 'tests/electron-handoff.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] })
    child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk) })
    const timer = setTimeout(() => {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      else child.kill('SIGKILL')
    }, 120000)
    child.on('error', reject)
    child.on('close', code => { clearTimeout(timer); code === 0 && output.includes('Handoff phase ' + phase + ' passed') ? resolve() : reject(Error('Handoff phase ' + phase + ' failed (' + code + ')')) })
  })
}
;(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    fs.writeFileSync(path.join(temporary, 'codex', 'config.toml'), `model = "gpt-5.4"\nmodel_provider = "handoff"\n[model_providers.handoff]\nname = "local test"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`)
    for (const phase of [1, 2, 3]) {
      if (phase === 2) {
        const file = path.join(data, 'config.json')
        const config = JSON.parse(fs.readFileSync(file, 'utf8'))
        config.pendingEngineSwitch = { engine: config.engine, cwd: workspace,
          session: config.engineSessions[config.engine], propheySessionId: config.propheySessionId,
          activeProject: config.activeProject }
        config.engine = config.engine === 'prophey' ? 'pi' : 'prophey'
        fs.writeFileSync(file, JSON.stringify(config))
      }
      await run(phase, port)
    }
    assert(fs.readFileSync(source, 'utf8').includes('PRIVATE_THOUGHT_SENTINEL'), 'source transcript must stay unchanged')
    console.log('Handoff integration passed: locked sessions, fresh-session engine choices, restart, rollback and source preservation')
  } finally {
    server.closeAllConnections(); server.close()
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()))
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
