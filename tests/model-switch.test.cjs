const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { pathToFileURL } = require('node:url')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const { image } = require('./history-fixture.cjs')

test('built-in engine switches OpenAI Responses / Anthropic / Chat Completions using real pi SDK adapters without rewriting history', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-model-switch-'))
  const requests = []
  let anthropicCalls = 0
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      const body = JSON.parse(raw)
      const url = new URL(req.url, 'http://localhost').pathname
      requests.push({ url, body })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const event = data => res.write('event: ' + data.type + '\ndata: ' + JSON.stringify(data) + '\n\n')
      if (url.endsWith('/messages')) {
        const tool = ++anthropicCalls === 1
        event({ type: 'message_start', message: { id: 'msg_proof', type: 'message', role: 'assistant', model: 'a', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })
        if (tool) {
          event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } })
          event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'ANTHROPIC_PRIVATE_THOUGHT' } })
          event({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'ANTHROPIC_SIGNATURE' } })
          event({ type: 'content_block_stop', index: 0 })
          event({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_proof', name: 'read_file', input: {} } })
          event({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"fixture.txt"}' } })
          event({ type: 'content_block_stop', index: 1 })
        } else {
          event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
          event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Anthropic completed' } })
          event({ type: 'content_block_stop', index: 0 })
        }
        event({ type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } })
        event({ type: 'message_stop' })
      } else if (url.endsWith('/chat/completions')) {
        res.write('data: ' + JSON.stringify({ id: 'chat_proof', choices: [{ index: 0, delta: { role: 'assistant', content: 'Chat completed' }, finish_reason: null }] }) + '\n\n')
        res.write('data: ' + JSON.stringify({ id: 'chat_proof', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n')
        res.write('data: [DONE]\n\n')
      } else {
        const item = { id: 'msg_response', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Responses completed', annotations: [] }] }
        const response = { id: 'resp_proof', object: 'response', status: 'completed', model: 'o', output: [item], usage: { input_tokens: 10, output_tokens: 8, total_tokens: 18, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }
        event({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } })
        event({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
        event({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'Responses completed' })
        event({ type: 'response.output_item.done', output_index: 0, item })
        event({ type: 'response.completed', response })
      }
      res.end()
    })
  })
  let engine
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = 'http://127.0.0.1:' + server.address().port
    const providers = {}
    for (const [provider, id, api, contextWindow] of [
      ['proof-openai', 'o', 'openai-responses', 32000],
      ['proof-anthropic', 'a', 'anthropic-messages', 32000],
      ['proof-chat', 'c', 'openai-completions', 1024]
    ]) providers[provider] = { apiKey: 'local-test', baseUrl: base + '/v1', api,
      models: [{ id, name: id, contextWindow, maxTokens: 512, input: ['text', 'image'], reasoning: true }] }
    const modelsPath = path.join(temp, 'models.json'), authPath = path.join(temp, 'auth.json')
    fs.writeFileSync(modelsPath, JSON.stringify({ providers }))
    fs.writeFileSync(authPath, '{}')
    const stub = path.join(temp, 'providers.mjs')
    fs.writeFileSync(stub, `
      let pending;
      export async function getRuntime() { return pending ??= (async () => {
        const { ModelRuntime } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href)});
        return ModelRuntime.create({ modelsPath: ${JSON.stringify(modelsPath)}, authPath: ${JSON.stringify(authPath)}, refreshOnCreate: false });
      })() }
      export async function listModelChoices() { return (await getRuntime()).getModels().filter(m => m.provider.startsWith('proof-')); }
      export async function thinkingLevelsFor(model) {
        const { getSupportedThinkingLevels } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'node_modules/@earendil-works/pi-ai/dist/models.js')).href)});
        return getSupportedThinkingLevels(model)
      }
    `)
    const source = fs.readFileSync(path.join(root, 'apps/desktop/src/main/agent/prophey-engine.ts'), 'utf8')
      .replace("from '../providers'", 'from ' + JSON.stringify(stub.replaceAll('\\', '/')))
    esbuild.buildSync({ stdin: { contents: source, loader: 'ts', resolveDir: path.join(root, 'apps/desktop/src/main/agent') }, outfile: path.join(temp, 'engine.cjs'), bundle: true, platform: 'node', packages: 'external' })
    esbuild.buildSync({ entryPoints: [path.join(root, 'apps/desktop/src/main/transcript-store.ts')], outfile: path.join(temp, 'store.cjs'), bundle: true, platform: 'node' })
    const { PropheyEngine } = require(path.join(temp, 'engine.cjs'))
    const { TranscriptStore } = require(path.join(temp, 'store.cjs'))
    const store = new TranscriptStore(path.join(temp, 'transcripts'))
    const options = { onStatus() {}, onEvent() {}, onSettled() {}, transcripts: store, sessionId: () => 'same-session' }
    engine = new PropheyEngine(options)
    await engine.start(temp, { model: { provider: 'proof-openai', id: 'o' } })
    const identity = engine.state().sessionFile
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
    const id = 'call_origin|fc_' + 'x'.repeat(80)
    const original = [
      { role: 'user', content: [{ type: 'text', text: 'Keep TOKEN-731 and this image' }, image], timestamp: 1 },
      { role: 'assistant', api: 'openai-responses', provider: 'proof-openai', model: 'o', usage, stopReason: 'toolUse', timestamp: 2, content: [
        { type: 'thinking', thinking: '', thinkingSignature: JSON.stringify({ type: 'reasoning', id: 'rs_old', encrypted_content: 'OPENAI_PRIVATE', summary: [] }) },
        { type: 'text', text: 'Reading original file', textSignature: 'OPENAI_TEXT_SIGNATURE' },
        { type: 'toolCall', id, name: 'read_file', arguments: { path: 'original.txt' } }
      ] },
      { role: 'toolResult', toolCallId: id, toolName: 'read_file', content: [{ type: 'text', text: 'TOKEN-731' }], isError: false, timestamp: 3 }
    ]
    engine.transcript = structuredClone(original)
    engine.tools = [{ name: 'read_file', description: 'Read fixture', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      call: async () => ({ content: [{ type: 'text', text: 'Tool returned TOKEN-731' }] }) }]
    const run = async (provider, model) => {
      await engine.setModel(provider, model)
      await engine.setThinkingLevel('off')
      assert.equal(engine.state().sessionFile, identity)
      const result = await engine.prompt('Continue TOKEN-731')
      assert.equal(result.ok, true, result.error)
      assert.deepEqual((await engine.messages()).slice(0, original.length), original)
    }
    await run('proof-anthropic', 'a')
    const anthropic = requests.find(r => r.url.endsWith('/messages')).body
    const textA = JSON.stringify(anthropic)
    assert(!textA.includes('OPENAI_PRIVATE') && !textA.includes('OPENAI_TEXT_SIGNATURE'))
    assert(textA.includes(image.data) && textA.includes('TOKEN-731'))
    const blocks = anthropic.messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
    const use = blocks.find(b => b.type === 'tool_use'), result = blocks.find(b => b.type === 'tool_result')
    assert.equal(use.id, result.tool_use_id)
    assert.match(use.id, /^[a-zA-Z0-9_-]{1,64}$/)
    await run('proof-openai', 'o')
    const responseInput = requests.find(r => r.url.endsWith('/responses')).body.input
    assert(!JSON.stringify(responseInput).includes('ANTHROPIC_SIGNATURE'))
    assert(!JSON.stringify(responseInput).includes('ANTHROPIC_PRIVATE_THOUGHT'))
    const call = responseInput.find(i => i.type === 'function_call' && i.call_id === 'toolu_proof')
    assert(call && responseInput.some(i => i.type === 'function_call_output' && i.call_id === call.call_id))
    await run('proof-chat', 'c')
    const chat = requests.find(r => r.url.endsWith('/chat/completions')).body
    assert(!JSON.stringify(chat).includes('ANTHROPIC_SIGNATURE') && !JSON.stringify(chat).includes('OPENAI_PRIVATE'))
    for (const message of chat.messages.filter(m => m.tool_calls)) {
      for (const call of message.tool_calls) assert(chat.messages.some(m => m.role === 'tool' && m.tool_call_id === call.id))
    }
    await run('proof-anthropic', 'a')
    const returned = requests.filter(r => r.url.endsWith('/messages')).at(-1).body
    assert(JSON.stringify(returned).includes('ANTHROPIC_SIGNATURE'))
    assert(!JSON.stringify(returned).includes('OPENAI_PRIVATE'))
    await store.load('same-session')
    engine.dispose()
    engine = new PropheyEngine(options)
    await engine.start(temp)
    assert.equal(engine.state().model.provider, 'proof-anthropic')
    assert.equal(engine.state().sessionFile, identity)
    assert.deepEqual((await engine.messages()).slice(0, original.length), original)
  } finally {
    engine?.dispose()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
  }
})
