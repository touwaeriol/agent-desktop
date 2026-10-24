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

test('legacy history: preserve roles, images and tool pairs while dropping thoughts, signatures and system rules', () => {
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
test('legacy history: tool-only and incomplete turns stay valid without inventing successful output', () => {
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
test('legacy history: compaction summaries survive and duplicate tool IDs fail explicitly', () => {
  assert.match(h.normalizeHistory([{ role: 'compactionSummary', summary: 'retained facts' }])[0].content[0].text, /retained facts/)
  assert.throws(() => h.normalizeHistory([{ role: 'assistant', content: [{ type: 'toolCall', id: 'same', name: 'a' }, { type: 'toolCall', id: 'same', name: 'b' }] }]), /重复/)
})
test('legacy history: mirrored Claude entries survive restart, deduplicate retries and discover subagent files', async () => {
  const dir = path.join(temp, 'store'), store = new ImportedHistoryStore(dir)
  const key = { sessionId: 'session-123', projectKey: temp }
  const rows = [{ type: 'user', uuid: 'legacy-one', parentUuid: null, message: { role: 'user', content: 'saved legacy conversation' } }]
  await Promise.all([store.append(key, rows), store.append(key, rows)])
  const restarted = new ImportedHistoryStore(dir)
  assert.deepEqual(await restarted.load(key), rows)
  assert.equal(await restarted.owns(key.sessionId), true)
  await store.append({ ...key, subpath: 'subagents/agent-1' }, [rows[0]])
  assert.deepEqual(await restarted.listSubkeys(key), ['subagents/agent-1'])
  await assert.rejects(store.load({ ...key, sessionId: '../escape' }), /无效/)
})
test('legacy history: Codex reads existing legacy imports after reopen and forks without accepting new imports', async () => {
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
  e.threadId = 'target'
  await store.savePrefix('target', clean)
  assert.equal(typeof e.importHistory, 'undefined')
  await e.readHistory()
  assert.deepEqual(await e.messages(), clean)
  assert.equal(await e.clone(), 'codex:fork')
  assert.deepEqual(await store.loadPrefix('fork'), clean)
  assert.equal(e.threadOptions().sandbox, 'read-only')
  assert.equal(h.mergeImportedHistory(clean, clean).length, clean.length)
})
test('legacy history: stringified tool arguments become valid native objects without losing their value', () => {
  const clean = h.normalizeHistory([{ role: 'assistant', content: [{ type: 'toolCall', id: 't', name: 'read', arguments: '{"path":"a.txt"}' }] }])
  assert.deepEqual(clean[0].content[0].arguments, { path: 'a.txt' })
  const malformed = h.normalizeHistory([{ role: 'assistant', content: [{ type: 'toolCall', id: 't', name: 'read', arguments: 'incomplete {' }] }])
  assert.deepEqual(malformed[0].content[0].arguments, { raw: 'incomplete {' })
})
test('legacy history: deleting an imported Claude fork removes its mirrored history and subkeys', async () => {
  const store = new ImportedHistoryStore(path.join(temp, 'delete'))
  const key = { sessionId: 'fork-123', projectKey: temp }
  await store.append(key, [{ type: 'user', uuid: 'one' }])
  await store.append({ ...key, subpath: 'subagents/agent-1' }, [{ type: 'user', uuid: 'two' }])
  await store.delete(key)
  assert.equal(await store.owns(key.sessionId), false)
  assert.equal(await store.load(key), null)
  assert.deepEqual(await store.listSubkeys(key), [])
})

test('legacy history: Claude tool-result images are retained without native source metadata', () => {
  const clean = h.normalizeHistory([
    { role: 'assistant', content: [{ type: 'toolCall', id: 'image-call', name: 'Read', arguments: {} }] },
    { role: 'toolResult', toolCallId: 'image-call', content: [{ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data }, signature: 'PRIVATE_IMAGE_SIGNATURE' }] }
  ])
  assert.deepEqual(clean[1].content, [image])
})
