const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const esbuild = require('esbuild')
const { messages, image } = require('./history-fixture.cjs')
const root = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-history-tests-'))
const load = name => {
  const output = path.join(temp, path.basename(name) + '.cjs')
  esbuild.buildSync({ entryPoints: [path.join(root, 'apps/desktop/src/main', name + '.ts')], outfile: output, bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
  return require(output)
}
const h = load('agent/history')
const { ImportedHistoryStore } = load('imported-history-store')
const { CodexEngine } = load('agent/codex-engine')
const { ClaudeCodeEngine, normalizeClaudeHistory } = load('agent/claude-engine')
after(() => fs.rmSync(temp, { recursive: true, force: true }))
const callbacks = { onStatus() {}, onEvent() {}, onSettled() {} }

test('handoff: preserve roles, images and tool pairs while dropping thoughts, signatures and system rules', () => {
  const before = JSON.stringify(messages)
  const clean = h.normalizeHistory([{ role: 'system', content: 'NEVER_TRANSFER_RULES' }, ...messages])
  assert.deepEqual(clean.map(m => m.role), ['user', 'assistant', 'toolResult', 'assistant'])
  assert.equal(clean[1].content[1].id, clean[2].toolCallId)
  assert.deepEqual(clean[0].content[1], image)
  assert(!JSON.stringify(clean).includes('PRIVATE_'))
  assert(!JSON.stringify(clean).includes('NEVER_TRANSFER_RULES'))
  assert.equal(JSON.stringify(messages), before)
  assert.deepEqual(h.normalizeHistory(clean), clean)
})
test('handoff: tool-only and incomplete turns stay valid without inventing successful output', () => {
  const clean = h.normalizeHistory([{ role: 'assistant', content: [{ type: 'thinking', thinking: 'secret' }] },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'one', name: 'Bash', arguments: { command: 'echo hello' } }] }])
  assert.equal(clean.length, 2)
  assert.equal(clean[1].isError, true)
  assert.match(clean[1].content[0].text, /状态未知/)
  assert.deepEqual(h.normalizeHistory(clean), clean)
  const orphan = h.normalizeHistory([{ role: 'toolResult', toolCallId: 'missing', toolName: 'Read', content: 'output' }])
  assert.equal(orphan[0].role, 'user')
  assert.match(orphan[0].content[0].text, /原调用记录缺失/)
})
test('handoff: compaction summaries survive and duplicate tool IDs fail explicitly', () => {
  assert.match(h.normalizeHistory([{ role: 'compactionSummary', summary: 'retained facts' }])[0].content[0].text, /retained facts/)
  assert.throws(() => h.normalizeHistory([{ role: 'assistant', content: [{ type: 'toolCall', id: 'same', name: 'a' }, { type: 'toolCall', id: 'same', name: 'b' }] }]), /重复/)
})
test('handoff: Claude entries form one parent chain and roundtrip to portable messages', () => {
  const clean = h.normalizeHistory(messages)
  const entries = h.toClaudeEntries(clean, 'session-123', temp)
  assert.equal(entries[0].parentUuid, null)
  for (let i = 1; i < entries.length; i++) assert.equal(entries[i].parentUuid, entries[i - 1].uuid)
  assert.equal(new Set(entries.map(e => e.uuid)).size, entries.length)
  assert.deepEqual(h.normalizeHistory(normalizeClaudeHistory(entries)), clean.map(({ timestamp, ...m }) => m))
})
test('handoff: Codex uses structured role/tool items, never one giant user prompt', () => {
  const items = h.toCodexItems(h.normalizeHistory(messages))
  assert.deepEqual(items.map(m => m.type), ['message', 'message', 'function_call', 'function_call_output', 'message'])
  assert.equal(items[0].role, 'user')
  assert.equal(items[1].role, 'assistant')
  assert.equal(items[2].call_id, items[3].call_id)
  assert.equal(items[0].content[1].type, 'input_image')
  assert(!JSON.stringify(items).includes('PRIVATE_'))
  const pi = h.toPiHistory(h.normalizeHistory(messages))
  assert.equal(pi[1].stopReason, 'toolUse')
  assert.equal(pi[3].stopReason, 'stop')
})
test('handoff: mirrored Claude entries survive restart, deduplicate retries and discover subagent files', async () => {
  const dir = path.join(temp, 'store'), store = new ImportedHistoryStore(dir)
  const key = { sessionId: 'session-123', projectKey: temp }
  const rows = h.toClaudeEntries(h.normalizeHistory(messages), key.sessionId, temp)
  await Promise.all([store.append(key, rows), store.append(key, rows)])
  const restarted = new ImportedHistoryStore(dir)
  assert.deepEqual(await restarted.load(key), rows)
  assert.equal(await restarted.owns(key.sessionId), true)
  await store.append({ ...key, subpath: 'subagents/agent-1' }, [rows[0]])
  assert.deepEqual(await restarted.listSubkeys(key), ['subagents/agent-1'])
  await assert.rejects(store.load({ ...key, sessionId: '../escape' }), /无效/)
})
test('handoff: Codex imports once, preserves display history after reopen and forks, and uses native sandbox enum', async () => {
  const store = new ImportedHistoryStore(path.join(temp, 'codex'))
  const e = new CodexEngine({ ...callbacks, binary: 'unused', historyStore: store, sandbox: () => 'read-only' })
  e.connected = true
  e.newSession = async () => { e.threadId = 'target'; e.transcript = [] }
  const calls = []
  e.rpc.request = async (method, params) => {
    calls.push({ method, params })
    if (method === 'thread/fork') return { thread: { id: 'fork' }, model: 'test' }
    if (method === 'thread/items/list') throw new Error('not supported')
    if (method === 'thread/read') return { thread: { turns: [] } }
    return {}
  }
  const clean = h.normalizeHistory(messages)
  await e.importHistory(clean)
  assert.equal(calls[0].method, 'thread/inject_items')
  await e.readHistory()
  assert.deepEqual(await e.messages(), clean)
  assert.equal(await e.clone(), 'codex:fork')
  assert.deepEqual(await store.loadPrefix('fork'), clean)
  assert.equal(e.threadOptions().sandbox, 'read-only')
  assert.equal(h.mergeImportedHistory(clean, clean).length, clean.length)
})
test('handoff: failed Codex import archives the new thread and leaves source prefix untouched', async () => {
  const store = new ImportedHistoryStore(path.join(temp, 'codex-fail'))
  const e = new CodexEngine({ ...callbacks, binary: 'unused', historyStore: store })
  e.newSession = async () => { e.threadId = 'failed-target' }
  const calls = []
  e.rpc.request = async method => { calls.push(method); if (method === 'thread/inject_items') throw Error('unsupported') }
  await assert.rejects(e.importHistory(h.normalizeHistory(messages)), /历史导入失败/)
  assert.deepEqual(calls, ['thread/inject_items', 'thread/archive'])
  assert.deepEqual(await store.loadPrefix('failed-target'), [])
})
test('handoff: Claude import creates a durable new session before attempting resume', async () => {
  const store = new ImportedHistoryStore(path.join(temp, 'claude'))
  const e = new ClaudeCodeEngine({ ...callbacks, binary: 'unused', historyStore: store })
  e.configureWorkspace(temp)
  e.connect = async () => { assert.equal(await store.owns(e.sessionId), true); return {} }
  await e.importHistory(h.normalizeHistory(messages))
  const options = await e.sessionOptions()
  assert.equal(options.sessionStore, store)
  assert.equal((await store.load({ sessionId: e.sessionId, projectKey: temp })).length, 4)
})

test('handoff: stringified tool arguments become valid native objects without losing their value', () => {
  const clean = h.normalizeHistory([{ role: 'assistant', content: [{ type: 'toolCall', id: 't', name: 'read', arguments: '{"path":"a.txt"}' }] }])
  assert.deepEqual(clean[0].content[0].arguments, { path: 'a.txt' })
  const malformed = h.normalizeHistory([{ role: 'assistant', content: [{ type: 'toolCall', id: 't', name: 'read', arguments: 'incomplete {' }] }])
  assert.deepEqual(malformed[0].content[0].arguments, { raw: 'incomplete {' })
})
test('handoff: deleting an imported Claude fork removes its mirrored history and subkeys', async () => {
  const store = new ImportedHistoryStore(path.join(temp, 'delete'))
  const key = { sessionId: 'fork-123', projectKey: temp }
  await store.append(key, [{ type: 'user', uuid: 'one' }])
  await store.append({ ...key, subpath: 'subagents/agent-1' }, [{ type: 'user', uuid: 'two' }])
  await store.delete(key)
  assert.equal(await store.owns(key.sessionId), false)
  assert.equal(await store.load(key), null)
  assert.deepEqual(await store.listSubkeys(key), [])
})

test('handoff: Claude tool-result images are retained without native source metadata', () => {
  const clean = h.normalizeHistory([
    { role: 'assistant', content: [{ type: 'toolCall', id: 'image-call', name: 'Read', arguments: {} }] },
    { role: 'toolResult', toolCallId: 'image-call', content: [{ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data }, signature: 'PRIVATE_IMAGE_SIGNATURE' }] }
  ])
  assert.deepEqual(clean[1].content, [image])
  assert.equal(h.toCodexItems(clean)[1].output[0].type, 'input_image')
  assert.equal(h.toClaudeEntries(clean, 'image-session', temp)[1].message.content[0].content[0].source.data, image.data)
})
