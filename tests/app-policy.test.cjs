const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-app-tests-'))
after(() => fs.rmSync(temp, { recursive: true, force: true }))
function load(relative) {
  const outfile = path.join(temp, path.basename(relative) + '.cjs')
  esbuild.buildSync({ entryPoints: [path.join(root, relative)], outfile, bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
  return require(outfile)
}
const { compactionRatio, compactionPercent, reserveFor, ratioFromTokens, ratioFromPercent } = load('apps/desktop/src/main/compaction-policy.ts')
const { executeEngineCommand, listEngineCommands } = load('apps/desktop/src/main/engine-commands.ts')
const { engineCapabilities } = load('apps/desktop/src/shared/engine.ts')
function engine(overrides = {}) {
  return {
    id: 'pi', capabilities: () => engineCapabilities('pi'), busy: () => false,
    models: async () => [{ provider: 'first', id: 'model' }],
    state: () => ({ model: { provider: 'first', id: 'model' } }),
    stats: async () => ({ tokens: { total: 7 } }),
    ...overrides
  }
}

test('compaction: all default consumers use 90%, including invalid persisted ratios', () => {
  for (const value of [undefined, NaN, Infinity, -1, 0, 1]) assert.equal(compactionRatio(value), 0.9)
  assert.equal(compactionRatio(0.5), 0.5)
})
test('compaction: small explicit token thresholds survive persistence and restart', () => {
  const ratio = ratioFromTokens(1000, 1_000_000)
  assert.equal(compactionRatio(ratio), ratio)
  assert.equal(compactionPercent(ratio), 0.1)
  assert.equal(reserveFor(1_000_000, ratio), 999000)
  assert.equal(ratioFromTokens(2_000_000, 1_000_000), 0.99)
  assert.equal(ratioFromPercent(90), 0.9)
})
test('compaction: rejects non-finite inputs before touching configuration', () => {
  for (const value of [NaN, Infinity, -1, 0]) assert.throws(() => ratioFromTokens(value, 128000), /正数/)
  for (const value of [undefined, 0, NaN, Infinity]) assert.throws(() => ratioFromTokens(1000, value), /窗口/)
  for (const value of [NaN, Infinity, 9, 100]) assert.throws(() => ratioFromPercent(value), /10%/)
})
test('commands: failed native discovery retains desktop commands but never forwards unknown input', async () => {
  let executed = false
  const e = engine({ nativeCommands: async () => { throw Error('offline') }, executeCommand: async () => { executed = true } })
  assert((await listEngineCommands(e)).some(c => c.name === '/status'))
  assert.equal((await executeEngineCommand(e, '/unknown', '', async () => {})).ok, false)
  assert.equal(executed, false)
})
test('commands: model selection is explicit when providers share a model id', async () => {
  const changed = [], selected = []
  const e = engine({ models: async () => [{ provider: 'first', id: 'same' }, { provider: 'second', id: 'same' }], setModel: async (...args) => { selected.push(args) } })
  const result = await executeEngineCommand(e, '/model', 'same', async () => changed.push(true))
  assert.equal(result.ok, false)
  assert.match(result.error, /不唯一/)
  assert.deepEqual(selected, [])
  assert.equal((await executeEngineCommand(e, '/model', 'second/same', async () => changed.push(true))).ok, true)
  assert.deepEqual(selected, [['second', 'same']])
  assert.equal(changed.length, 1)
})
test('commands: busy engines cannot execute mutations', async () => {
  let called = false
  const e = engine({ busy: () => true, setThinkingLevel: async () => { called = true } })
  assert.equal((await executeEngineCommand(e, '/thinking', 'high', async () => {})).ok, false)
  assert.equal(called, false)
})
test('commands: native execution and status use the supplied engine', async () => {
  const calls = []
  const e = engine({ id: 'codex', nativeCommands: async () => [{ name: '/review', action: 'native', source: 'engine' }], executeCommand: async (...args) => { calls.push(args); return { text: 'reviewed' } } })
  assert.deepEqual(await executeEngineCommand(e, '/review', 'changes', async () => {}), { ok: true, text: 'reviewed' })
  assert.deepEqual(calls, [['/review', 'changes']])
  const status = JSON.parse((await executeEngineCommand(e, '/status', '', async () => {})).text)
  assert.equal(status.engine, 'codex')
  assert.equal(status.tokens.total, 7)
})
test('preload: all event subscriptions hide Electron events and clean up independently', () => {
  const ipc = new EventEmitter()
  let bridge
  const source = esbuild.buildSync({ entryPoints: [path.join(root, 'apps/desktop/src/preload/index.ts')], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false }).outputFiles[0].text
  vm.runInNewContext(source, { require: id => { assert.equal(id, 'electron'); return { ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (key, value) => { assert.equal(key, 'pi'); bridge = value } } } } })
  const events = { onUpdate: 'app-update', onLoginMessage: 'providers:login-message', onMcpState: 'mcp:state', onAskRequest: 'ask:request', onAskCleared: 'ask:cleared', onEvent: 'pi:event', onStatus: 'pi:status', onSubagentUpdate: 'subagents:update' }
  for (const [method, channel] of Object.entries(events)) {
    const seen = [], payload = { value: 1 }
    const remove = bridge[method](value => seen.push(value))
    const other = bridge[method](() => {})
    ipc.emit(channel, { sender: 'private' }, payload)
    assert.deepEqual(seen, [payload])
    remove(); remove()
    assert.equal(ipc.listenerCount(channel), 1)
    other()
    assert.equal(ipc.listenerCount(channel), 0)
  }
})
