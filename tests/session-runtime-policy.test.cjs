const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const esbuild = require('esbuild')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prophey-policy-'))
for (const [name, source] of [['policy', 'shared/session-policy'], ['guard', 'main/agent/stream-guard'], ['recents', 'shared/recent-directories']]) {
  esbuild.buildSync({ entryPoints: [path.resolve(__dirname, '../apps/desktop/src', source + '.ts')], outfile: path.join(temp, name + '.cjs'), bundle: true, platform: 'node' })
}
after(() => fs.rmSync(temp, { recursive: true, force: true }))
const { conversationHasStarted } = require(path.join(temp, 'policy.cjs'))
const { guardedStream } = require(path.join(temp, 'guard.cjs'))
const { recentDirectories } = require(path.join(temp, 'recents.cjs'))

test('recent directories keep latest ordering, deduplicate Windows aliases and preserve different paths with the same name', () => {
  assert.deepEqual(recentDirectories(['D:\\Work\\Repo', 'd:/work/repo/', '', 'D:/other/Repo', '/code/Repo', '/code/repo']),
    ['D:\\Work\\Repo', 'D:/other/Repo', '/code/Repo', '/code/repo'])
  assert.equal(recentDirectories(Array.from({ length: 30 }, (_, i) => 'D:/repo' + i)).length, 24)
})

test('session setup locks on real text, image or tool history, not headers and background notices', () => {
  assert.equal(conversationHasStarted([]), false)
  assert.equal(conversationHasStarted([{ role: 'user', content: '' }]), false)
  assert.equal(conversationHasStarted([{ role: 'user', content: 'notice', customType: 'subagent_notice' }]), false)
  for (const message of [{ role: 'user', content: 'hi' }, { role: 'user', content: [{ type: 'image' }] }, { role: 'assistant', content: [{ type: 'toolCall' }] }]) {
    assert.equal(conversationHasStarted([message]), true)
  }
})

test('a stalled provider stream times out and cancels the underlying request', async () => {
  let requestSignal
  const stalled = guardedStream(signal => {
    requestSignal = signal
    return { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}), return: async () => ({ done: true }) } } }
  }, undefined, 20)
  await assert.rejects(stalled.next(), /timeout/)
  assert.equal(requestSignal.aborted, true)
})

test('provider cancellation is prompt and an active long stream is not timed out', async () => {
  const controller = new AbortController()
  const waiting = guardedStream(() => ({ [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}) } } }), controller.signal, 10000)
  const pending = waiting.next()
  controller.abort(new Error('user stopped'))
  await assert.rejects(pending, /user stopped/)
  const output = []
  for await (const item of guardedStream(async function* () {
    for (let i = 0; i < 5; i++) { await new Promise(resolve => setTimeout(resolve, 10)); yield i }
  }, undefined, 40)) output.push(item)
  assert.deepEqual(output, [0, 1, 2, 3, 4])
})
