const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawn } = require('node:child_process')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-context-tests-'))
const agentDir = path.join(temp, 'profile')
fs.mkdirSync(agentDir)
const authFile = path.join(agentDir, 'auth.json')
const authBody = JSON.stringify({ openai: { type: 'api_key', key: 'local-test-not-a-real-key' } })
fs.writeFileSync(authFile, authBody)
const electron = path.join(temp, 'electron.cjs')
fs.writeFileSync(electron, 'exports.shell = {}')
const offline = process.env.PI_OFFLINE
process.env.PI_OFFLINE = '1'

// Keep real SDK adapters, resolving their ESM imports from this checkout even
// though our test bundle/profile live in an isolated OS temporary directory.
esbuild.buildSync({
  stdin: { contents: `
    export * as context from '../../resources/extension/model-context';
    export * as providers from './providers';
    export * as profile from './profile';
    export { PropheyEngine } from './agent/prophey-engine';
    export { reserveFor } from './compaction-policy';
  `, loader: 'ts', resolveDir: path.join(root, 'apps/desktop/src/main') },
  outfile: path.join(temp, 'context.cjs'), bundle: true, platform: 'node', packages: 'external',
  alias: { electron,
    '@earendil-works/pi-coding-agent': pathToFileURL(path.join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href,
    '@earendil-works/pi-ai/models': pathToFileURL(path.join(root, 'node_modules/@earendil-works/pi-ai/dist/models.js')).href
  }
})
const { context, providers, profile, PropheyEngine, reserveFor } = require(path.join(temp, 'context.cjs'))
profile.setAgentDir(agentDir)
after(() => {
  if (offline === undefined) delete process.env.PI_OFFLINE
  else process.env.PI_OFFLINE = offline
  fs.rmSync(temp, { recursive: true, force: true })
})
const ids = ['gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol']

test('context correction is narrow, immutable and preserves dynamic provider behavior', () => {
  const original = { provider: 'openai', id: ids[0], type: 'chat', contextWindow: 272000, maxTokens: 128000, cost: { tiers: [{ inputTokensAbove: 272000 }] }, thinkingLevelMap: { high: 'high' } }
  let models = [original]
  const classifier = { ...original, type: 'classifier' }
  const provider = { id: 'openai', auth: {}, getModels: () => models, getAllModels: () => [...models, classifier], refreshModels() {}, streamSimple() {} }
  const corrected = context.withModelContextCorrections(provider)
  assert.deepEqual(corrected.getModels()[0], { ...original, contextWindow: 1050000 })
  assert.equal(original.contextWindow, 272000)
  assert.equal(corrected.getModels()[0].cost, original.cost)
  assert.equal(corrected.getAllModels()[1], classifier)
  assert.equal(corrected.auth, provider.auth)
  assert.equal(corrected.refreshModels, provider.refreshModels)
  assert.equal(corrected.streamSimple, provider.streamSimple)
  models = [{ ...original, contextWindow: 2000000 }, { ...original, id: 'gpt-future' }]
  assert.deepEqual(corrected.getModels(), models, 'new SDK limits and unknown models are untouched')
  models = [{ ...original, contextWindow: 500000 }]
  assert.deepEqual(corrected.getModels(), models, 'only the known 272K catalog value is corrected')
  const codex = { ...provider, id: 'openai-codex' }
  assert.equal(context.withModelContextCorrections(codex), codex, 'do not infer subscription endpoint limits')
})

test('real SDK catalog, provider/model pickers and Prophey compaction share the corrected window', async () => {
  const runtime = await providers.getRuntime()
  const list = await providers.listProviderModels('openai')
  const choices = await providers.listModelChoices()
  for (const id of ids) {
    const model = runtime.getModel('openai', id)
    assert.equal(model.contextWindow, 1050000)
    assert.equal(model.maxTokens, 128000)
    assert.equal(model.cost.tiers[0].inputTokensAbove, 272000, 'pricing threshold is NOT the window')
    assert.equal(list.find(m => m.modelId === id).contextWindow, 1050000)
    assert.equal(choices.find(m => m.provider === 'openai' && m.id === id).contextWindow, 1050000)
  }
  assert.equal(runtime.getModelOfType('classifier', 'openai', 'gpt-6-luna').contextWindow, 922000)
  assert.equal(runtime.getModel('openai-codex', 'gpt-6-astra').contextWindow, 272000)
  await runtime.refresh({ allowNetwork: false, providers: ['openai'] })
  assert.equal(runtime.getModel('openai', ids[0]).contextWindow, 1050000)
  const engine = new PropheyEngine({ onStatus() {}, onEvent() {}, onSettled() {}, autoCompact: () => ({ enabled: true, percent: 90 }) })
  try {
    await engine.start(temp, { model: { provider: 'openai', id: ids[0] } })
    assert.equal(engine.state().model.contextWindow, 1050000)
    assert.equal((await engine.stats()).contextUsage.contextWindow, 1050000)
    engine.transcript = [{ role: 'user', content: 'x'.repeat(300000 * 4) }]
    assert.equal(engine.shouldCompact(), false, '300K must no longer trigger a 244.8K compaction threshold')
    engine.transcript = [{ role: 'user', content: 'x'.repeat(950000 * 4) }]
    assert.equal(engine.shouldCompact(), true, '90% of 1.05M still triggers compaction')
    assert.equal(reserveFor(1050000, 0.9), 105000)
    await engine.setModel('openai', 'gpt-6.1-sol')
    assert.equal(engine.state().model.contextWindow, 1050000)
  } finally { engine.dispose() }
  assert.equal(fs.readFileSync(authFile, 'utf8'), authBody)
  assert.equal(fs.existsSync(path.join(agentDir, 'models.json')), false, 'no user model file is created by the correction')
})

test('explicit user model definitions/overrides win, including an intentional 272K limit', async () => {
  const file = path.join(agentDir, 'models.json')
  const body = JSON.stringify({ providers: { openai: {
    baseUrl: 'https://proxy.example.test/v1',
    modelOverrides: { 'gpt-6-astra': { contextWindow: 272000 }, 'gpt-6-sol': { contextWindow: 640000 } },
    models: [{ id: 'gpt-6-luna', name: 'Custom Luna', contextWindow: 500000, maxTokens: 32000, reasoning: true, input: ['text'] }]
  } } })
  fs.writeFileSync(file, body)
  providers.invalidateCache()
  const runtime = await providers.getRuntime()
  assert.equal(runtime.getModel('openai', 'gpt-6-astra').contextWindow, 272000)
  assert.equal(runtime.getModel('openai', 'gpt-6-sol').contextWindow, 640000)
  assert.equal(runtime.getModel('openai', 'gpt-6-luna').contextWindow, 500000)
  assert.equal(runtime.getModel('openai', 'gpt-6-luna').maxTokens, 32000)
  assert.equal(runtime.getModel('openai', 'gpt-6.1-sol').contextWindow, 1050000)
  assert.equal(runtime.getModel('openai', 'gpt-6.1-sol').baseUrl, 'https://proxy.example.test/v1')
  assert.equal(fs.readFileSync(file, 'utf8'), body)
  fs.unlinkSync(file)
  providers.invalidateCache()
})

async function withPiContext(extraExtensions, check) {
  const child = spawn(process.execPath, [
    path.join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),
    '--mode', 'rpc', '--no-mcp', '--no-extensions', '--no-skills', '--no-prompt-templates',
    '--extension', path.join(root, 'apps/desktop/resources/extension/model-context.ts'),
    ...extraExtensions.flatMap(file => ['--extension', file]),
    '--provider', 'openai', '--model', 'gpt-6-astra', '--session-dir', path.join(temp, 'sessions')
  ], { cwd: temp, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = '', stderr = ''
  const pending = new Map()
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', text => { stderr = (stderr + text).slice(-5000) })
  child.stdout.on('data', text => {
    buffer += text
    for (;;) {
      const index = buffer.indexOf('\n')
      if (index < 0) break
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
      try { const record = JSON.parse(line); pending.get(record.id)?.(record) } catch { /* non-RPC log */ }
    }
  })
  const exited = new Promise(resolve => child.once('exit', resolve))
  const request = type => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(type); reject(new Error(type + ' timed out: ' + stderr)) }, 30000)
    pending.set(type, record => {
      clearTimeout(timer); pending.delete(type)
      if (record.success === false) reject(new Error(JSON.stringify(record) + '\n' + stderr))
      else resolve(record.data)
    })
    child.stdin.write(JSON.stringify({ id: type, type }) + '\n')
  })
  try {
    await check(request, () => stderr)
  } finally {
    child.stdin.end()
    child.kill()
    await exited
  }
}

test('desktop pi extension corrects real RPC state and model list with MCP disabled', { timeout: 45000 }, async () => {
  await withPiContext([], async (request, stderr) => {
    const state = await request('get_state')
    assert.equal(state.model.contextWindow, 1050000, stderr())
    const { models } = await request('get_available_models')
    for (const id of ids) assert.equal(models.find(m => m.provider === 'openai' && m.id === id).contextWindow, 1050000)
  })
})

test('pi correction does not replace a user extension provider, credentials or custom models', { timeout: 45000 }, async () => {
  const file = path.join(temp, 'user-provider.ts')
  fs.writeFileSync(file, `export default function(pi) {
    pi.registerProvider('openai', {
      baseUrl: 'https://user-extension.invalid/v1', apiKey: 'extension-local-test', api: 'openai-responses',
      models: [{ id: 'gpt-6-astra', name: 'User Astra', contextWindow: 32000, maxTokens: 2048,
        reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]
    })
  }`)
  await withPiContext([file], async (request, stderr) => {
    const { model } = await request('get_state')
    assert.equal(model.contextWindow, 32000, stderr())
    assert.equal(model.baseUrl, 'https://user-extension.invalid/v1')
    const { models } = await request('get_available_models')
    const own = models.filter(m => m.provider === 'openai')
    assert.equal(own.length, 1)
    assert.equal(own[0].name, 'User Astra')
  })
})
