const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const esbuild = require('esbuild')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-engine-tests-'))
const root = path.resolve(__dirname, '..')
const sources = ['shared/engine', 'main/session-store', 'main/agent/codex-engine', 'main/agent/claude-engine', 'main/agent/json-rpc-process']
for (const file of sources) esbuild.buildSync({ entryPoints: [path.join(root, 'apps/desktop/src', file + '.ts')], outfile: path.join(temp, path.basename(file) + '.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
const fakeProvider=path.join(temp,'provider.mjs')
fs.writeFileSync(fakeProvider,'export async function getRuntime(){return {}}; export async function listModelChoices(){return []}')
const propheySource=fs.readFileSync(path.join(root,'apps/desktop/src/main/agent/prophey-engine.ts'),'utf8').replace("from '../providers'", "from " + JSON.stringify(fakeProvider.replaceAll('\\','/')))
esbuild.buildSync({ stdin: { contents: propheySource, loader: 'ts', resolveDir: path.join(root,'apps/desktop/src/main/agent') }, outfile: path.join(temp,'prophey-engine.cjs'), bundle:true, platform:'node', format:'cjs', packages:'external' })

const { engineCapabilities, engineCommands, isNativeSessionReference } = require(path.join(temp, 'engine.cjs'))
const { CodexEngine } = require(path.join(temp, 'codex-engine.cjs'))
const { ClaudeCodeEngine } = require(path.join(temp, 'claude-engine.cjs'))
const { SessionStore, toSummary } = require(path.join(temp, 'session-store.cjs'))
const { JsonRpcProcess } = require(path.join(temp, 'json-rpc-process.cjs'))
after(() => fs.rmSync(temp, { recursive: true, force: true }))
const callbacks = (events = []) => ({ onStatus() {}, onEvent(e) { events.push(e) }, onSettled() {} })
function codex(events = []) {
  const engine = new CodexEngine({ ...callbacks(events), binary: process.execPath })
  engine.connected = true; engine.threadId = 'test-thread'; engine.setStatus({ phase: 'ready' })
  return engine
}
for (const id of ['pi', 'prophey', 'claude', 'codex']) test(id + ': command catalogue matches capability ownership', () => {
  const caps = engineCapabilities(id), commands = engineCommands(caps)
  assert.equal(commands.some(c => c.name === '/compact'), caps.compact)
  assert.equal(commands.some(c => c.name === '/autocompact'), caps.autoCompaction === 'configurable')
  assert.equal(commands.some(c => c.name === '/mcp'), caps.mcp === 'managed')
  assert.equal(commands.some(c => c.name === '/thinking'), caps.thinking)
  assert.equal(new Set(commands.map(c => c.name)).size, commands.length)
  const native = engineCommands(caps, [{ name: '/model', action: 'native' }, { name: '/review', action: 'native' }])
  assert.equal(native.filter(c => c.name === '/model').length, 1)
  assert.equal(native.find(c => c.name === '/model').action, 'model')
  assert.equal(native.find(c => c.name === '/review').action, 'native')
})
test('Codex: images are sent on the wire and turns wait for completion', async () => {
  const e = codex(), calls = []
  e.rpc.request = async (method, params) => { calls.push({ method, params }); return { turn: { id: 'turn-1' } } }
  let finished = false
  const prompt = e.prompt('image', { images: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }] }).then(r => { finished = true; return r })
  await new Promise(r => setImmediate(r))
  assert.equal(e.busy(), true); assert.equal(finished, false)
  assert.deepEqual(calls[0].params.input[1], { type: 'image', url: 'data:image/png;base64,aGVsbG8=' })
  e.handle('turn/completed', { threadId: 'another-thread', turn: {} }); assert.equal(e.busy(), true)
  e.handle('turn/completed', { threadId: 'test-thread', turn: { status: 'completed' } })
  assert.equal((await prompt).ok, true); assert.equal(e.busy(), false)
})
test('Codex: compaction acknowledgement does not mean compaction finished', async () => {
  const events = [], e = codex(events)
  e.rpc.request = async () => ({})
  e.readHistory = async () => {}
  const compact = e.compact()
  await new Promise(r => setImmediate(r))
  assert.equal(e.compacting(), true)
  e.handle('item/completed', { threadId: 'test-thread', item: { type: 'contextCompaction', id: 'compact' } })
  assert.equal(e.busy(), true)
  e.handle('turn/completed', { threadId: 'test-thread', turn: { status: 'completed' } })
  await compact
  assert.equal(e.busy(), false)
  assert(events.some(e => e.type === 'agent_settled'))
  await assert.rejects(e.compact('unsupported instructions'), /不接受/)
})
test('Codex: failure and stop settle the pending caller', async () => {
  for (const stop of [false, true]) {
    const e = codex(); e.rpc.request = async () => ({ turn: { id: 'turn-1' } }); e.rpc.stop = () => {}
    const pending = e.prompt('hello')
    await new Promise(r => setImmediate(r))
    if (stop) e.stop(); else e.handle('error', { threadId: 'test-thread', willRetry: false, error: { message: 'test failure' } })
    assert.equal((await pending).ok, false); assert.equal(e.busy(), false)
  }
})
test('Codex: steering has an active-turn precondition', async () => {
  const e = codex(); e.active = true; e.turnId = 'active'; let call
  e.rpc.request = async (method, params) => { call = { method, params }; return {} }
  assert.equal((await e.prompt('steer', { behavior: 'steer' })).ok, true)
  assert.equal(call.method, 'turn/steer'); assert.equal(call.params.expectedTurnId, 'active')
  assert.equal((await e.prompt('normal')).ok, false)
})
test('Codex: older servers restore history without pagination', async () => {
  const e = codex()
  e.rpc.request = async (method) => {
    if (method === 'thread/items/list') throw new Error('thread/items/list is not supported yet')
    assert.equal(method, 'thread/read')
    return { thread: { turns: [{ items: [{ type: 'agentMessage', id: 'a', text: 'restored' }] }] } }
  }
  await e.readHistory(); assert.equal(await e.lastAssistantText(), 'restored')
})
test('Claude: tool start and end share the real tool-use ID', async () => {
  const events = [], e = new ClaudeCodeEngine({ ...callbacks(events), binary: 'unused' })
  e.handle({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'real-id', name: 'Read', input: { file_path: 'a' } }] } })
  e.handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'real-id', content: 'ok' }] } })
  const tools = events.filter(e => e.type.startsWith('tool_execution_'))
  assert.deepEqual(tools.map(e => e.toolCallId), ['real-id', 'real-id'])
  assert.deepEqual(tools.map(e => e.toolName), ['Read', 'Read'])
})
test('native auto-compaction cannot report a fake configurable success', async () => {
  for (const e of [codex(), new ClaudeCodeEngine({ ...callbacks(), binary: 'unused' })]) await assert.rejects(e.setAutoCompaction({ enabled: false }), /原生管理/)
})
test('session store retains engine identity and opaque native references', async () => {
  const file = path.join(temp, 'sessions.json'), store = new SessionStore(file)
  await store.upsert({ engine: 'claude', path: 'claude:abc-123', cwd: root })
  await store.upsert({ engine: 'codex', path: 'codex:def-456', cwd: root })
  await store.upsert({ engine: 'pi', path: path.join(temp, 'missing.jsonl'), cwd: root })
  await store.prune(ref => !isNativeSessionReference(ref) && !fs.existsSync(ref))
  const restored = new SessionStore(file); await restored.load()
  assert.deepEqual(restored.list().map(r => r.engine).sort(), ['claude', 'codex'])
})

test('session engine changes preserve sidebar identity and do not change neighboring sessions', async () => {
  const file = path.join(temp, 'session-engine-identity.json'), store = new SessionStore(file)
  const first = await store.upsert({ engine: 'prophey', path: path.join(temp, 'first.jsonl'), cwd: root, title: 'First' })
  const second = await store.upsert({ engine: 'pi', path: path.join(temp, 'second.jsonl'), cwd: root, title: 'Second' })
  const key = toSummary(first).path
  await store.upsert({ id: first.id, engine: 'claude', path: 'claude:switched' }, true)
  const restored = new SessionStore(file)
  await restored.load()
  assert.equal(restored.list().length, 2)
  assert.equal(toSummary(restored.get(first.id)).path, key)
  assert.equal(restored.byPath(key).path, 'claude:switched')
  assert.equal(restored.byPath('claude:switched').id, first.id)
  assert.equal(toSummary(restored.get(first.id)).engine, 'claude')
  assert.equal(restored.get(first.id).title, 'First')
  assert.deepEqual(restored.get(second.id), second)
})
test('JSON-RPC requests fail promptly when a process exits', async () => {
  const rpc = new JsonRpcProcess(() => {}, async () => ({}), () => {})
  rpc.start(process.execPath, ['-e', 'process.exit(0)'], temp)
  await assert.rejects(rpc.request('pending', {}, 5000), /连接关闭/)
  rpc.stop()
})

test('Claude: images use the native content format', async () => {
  const e = new ClaudeCodeEngine({ ...callbacks(), binary: 'unused' }); let wire
  e.query = {}; e.input = { push(m) { wire = m; setImmediate(() => e.handle({ type: 'result', subtype: 'success', result: 'ok' })) } }
  const result = await e.prompt('image', { images: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }] })
  assert.equal(result.ok, true)
  assert.deepEqual(wire.message.content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } })
})
test('Claude: compact is a native command, and success requires the compact boundary', async () => {
  for (const boundary of [true, false]) {
    const e = new ClaudeCodeEngine({ ...callbacks(), binary: 'unused' }); let wire
    e.sessionId = 'test'; e.query = {}; e.readHistory = async () => {}
    e.input = { push(m) { wire = m; setImmediate(() => {
      if (boundary) e.handle({ type: 'system', subtype: 'compact_boundary' })
      e.handle({ type: 'result', subtype: 'success', result: boundary ? 'compacted' : 'Not enough messages' })
    }) } }
    if (boundary) await e.compact('retain decisions')
    else await assert.rejects(e.compact('retain decisions'), /Not enough/)
    assert.equal(wire.message.content[0].text, '/compact retain decisions')
    assert.equal(e.busy(), false)
  }
})
test('Claude: native compaction failure releases busy state', async () => {
  const e = new ClaudeCodeEngine({ ...callbacks(), binary: 'unused' })
  const waiting = e.begin(true)
  e.handle({ type: 'system', subtype: 'status', compact_result: 'failed', compact_error: 'server refused' })
  await assert.rejects(waiting, /server refused/); assert.equal(e.busy(), false)
})

test('native restored histories preserve tool calls and results', async () => {
 const {normalizeClaudeHistory}=require(path.join(temp,'claude-engine.cjs'))
 const history=normalizeClaudeHistory([
  {type:'assistant',message:{content:[{type:'tool_use',id:'t1',name:'Read',input:{file_path:'a'}}]}},
  {type:'user',message:{content:[{type:'tool_result',tool_use_id:'t1',content:'result'}]}}
 ])
 assert.equal(history[0].content[0].type,'toolCall')
 assert.equal(history[1].role,'toolResult'); assert.equal(history[1].toolCallId,'t1')
 const e=codex();e.applyItem({type:'commandExecution',id:'t2',command:'echo ok',aggregatedOutput:'ok',status:'completed'},false)
 const restored=await e.messages();assert.equal(restored[0].content[0].id,'t2');assert.equal(restored[1].toolCallId,'t2')
})

test('Prophey: stopping cancels the current request before accepting another turn', async () => {
 const {PropheyEngine}=require(path.join(temp,'prophey-engine.cjs'))
 const e=new PropheyEngine(callbacks());e.model={id:'mock',provider:'mock',api:'mock',contextWindow:1000};e.tools=[];e.setStatus({phase:'ready'})
 e.streamRoundWithRetry=async()=>new Promise(resolve=>e.controller.signal.addEventListener('abort',()=>resolve({ok:false,error:'cancelled'}),{once:true}))
 const pending=e.prompt('hello');await new Promise(r=>setImmediate(r));assert(e.busy())
 await e.abort();assert.equal((await pending).ok,false);assert.equal(e.busy(),false)
 e.streamRoundWithRetry=async()=>({ok:true,message:{role:'assistant',content:[]}})
 assert.equal((await e.prompt('next')).ok,true)
})

test('Prophey: provider reload preserves an unsaved empty session and refreshes its model', async () => {
  const { PropheyEngine } = require(path.join(temp, 'prophey-engine.cjs'))
  const store = { pathFor: id => path.join(temp, id + '.jsonl'), load: async () => undefined }
  const engine = new PropheyEngine({ ...callbacks(), transcripts: store, sessionId: () => 'empty' })
  await engine.start(temp)
  const session = engine.state().sessionFile
  const oldModel = { id: 'model', provider: 'provider', baseUrl: 'https://old.invalid' }
  engine.model = oldModel
  engine.setModel = async (provider, id) => {
    assert.equal(provider, 'provider')
    assert.equal(id, 'model')
    engine.model = { ...oldModel, baseUrl: 'https://new.invalid' }
  }
  await engine.start(temp, { session })
  assert.equal(engine.state().sessionFile, session)
  assert.deepEqual(await engine.messages(), [])
  assert.equal(engine.model.baseUrl, 'https://new.invalid')
  await assert.rejects(engine.start(temp, { session: store.pathFor('missing') }), /会话不存在/)
})

test('Claude: native tools and configured MCPs survive retired desktop tool settings', async () => {
  const sdk = path.join(temp, 'claude-tool-policy-sdk.mjs')
  fs.writeFileSync(sdk, `
    export function query({ options }) {
      globalThis.__claudeToolPolicyOptions = options;
      let close;
      const closed = new Promise(resolve => { close = resolve });
      return {
        supportedModels: async () => [], supportedCommands: async () => [], close,
        async *[Symbol.asyncIterator]() { await closed }
      };
    }
  `)
  const source = fs.readFileSync(path.join(root, 'apps/desktop/src/main/agent/claude-engine.ts'), 'utf8')
    .replaceAll("await import('@anthropic-ai/claude-agent-sdk')", 'await import(' + JSON.stringify(sdk.replaceAll('\\', '/')) + ')')
  const output = path.join(temp, 'claude-tool-policy.cjs')
  esbuild.buildSync({ stdin: { contents: source, loader: 'ts', resolveDir: path.join(root, 'apps/desktop/src/main/agent') }, outfile: output, bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
  const { ClaudeCodeEngine } = require(output)
  let readRetiredSettings = false
  const engine = new ClaudeCodeEngine({
    ...callbacks(), binary: 'unused',
    disabledTools: () => {
      readRetiredSettings = true
      return ['Bash', 'Read', 'Write', 'Edit', 'Task', 'WebSearch', 'WebFetch']
    }
  })
  try {
    await engine.start(temp)
    const options = globalThis.__claudeToolPolicyOptions
    assert.equal(readRetiredSettings, false)
    assert.equal(options.tools, undefined)
    assert.equal(options.disallowedTools, undefined)
    assert.equal(options.mcpServers, undefined, 'do not inject desktop MCP tools')
    assert.equal(options.strictMcpConfig, undefined, 'do not suppress the user’s MCP configuration')
    assert.deepEqual(options.settingSources, ['user', 'project', 'local'])
    assert.equal(typeof options.canUseTool, 'function', 'native approval handling remains intact')
    assert.equal(engine.capabilities().toolPolicy, 'native')
    assert.equal(engine.capabilities().mcp, 'native')
  } finally {
    engine.stop()
    delete globalThis.__claudeToolPolicyOptions
  }
})
