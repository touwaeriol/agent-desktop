const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const path = require('node:path')
const root = process.env.PROPHEY_HANDOFF_ROOT, temp = process.env.PROPHEY_HANDOFF_TEMP
const native = process.env.PROPHEY_HANDOFF_NATIVE === '1', phase = Number(process.env.PROPHEY_HANDOFF_PHASE)
app.setPath('userData', path.join(temp, 'user-data'))
app.setAppPath(path.join(root, 'apps/desktop'))
BrowserWindow.prototype.show = function () {}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(probe, label) {
  for (let i = 0; i < 150; i++) { if (await probe()) return; await delay(100) }
  throw Error('Timed out: ' + label)
}
app.on('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', async () => {
    const run = source => window.webContents.executeJavaScript(source)
    try {
      await until(() => run('window.pi.getStatus().then(s => s.phase === "ready" && s.sessionLocked)'), 'restored session lock')
      const before = await run('window.pi.getStatus()')
      const history = await run('window.pi.getMessages()')
      assert(JSON.stringify(history).includes('ORCHID-731'))
      await until(() => run('document.querySelector(".composer-right .engine-picker select")?.disabled'), 'locked agent beside model')
      assert.equal(await run('document.querySelector(".composer-left .chip").disabled'), true)
      for (const engine of ['pi', 'claude', 'codex']) {
        await assert.rejects(run('window.pi.setEngine(' + JSON.stringify(engine) + ')'), /会话已开始/)
      }
      await assert.rejects(run('window.pi.restart(' + JSON.stringify(path.join(temp, 'other')) + ')'), /不能修改目录/)
      assert.equal((await run('window.pi.getStatus()')).sessionFile, before.sessionFile)
      assert.deepEqual(await run('window.pi.getMessages()'), history)
      assert.equal((await run('window.pi.setModel("unknown", "invented")')).ok, false)
      if (phase === 1) {
        assert.equal((await run('window.pi.newSession()')).ok, true)
        assert.equal((await run('window.pi.getStatus()')).sessionLocked, false)
        assert.equal((await run('window.pi.setEngine("pi")')).engine, 'pi')
        if (native) {
          assert.equal((await run('window.pi.setEngine("claude")')).engine, 'claude')
          assert.equal((await run('window.pi.setEngine("codex")')).engine, 'codex')
        }
        assert.equal((await run('window.pi.setEngine("prophey")')).engine, 'prophey')
        const keys = await run('window.pi.listSessions()')
        const source = keys.find(s => s.title === 'PRIMARY SESSION')
        await run('window.pi.openSession(' + JSON.stringify(source.path) + ',' + JSON.stringify(source.cwd) + ')')
        assert.equal((await run('window.pi.getStatus()')).sessionLocked, true)
        const second = keys.find(s => s.title === 'SECOND SESSION')
        await run('window.pi.openSession(' + JSON.stringify(second.path) + ',' + JSON.stringify(second.cwd) + ')')
        assert.equal((await run('window.pi.getStatus()')).sessionLocked, true)
        assert(JSON.stringify(await run('window.pi.getMessages()')).includes('SECOND_SESSION_SENTINEL'))
        await run('window.pi.openSession(' + JSON.stringify(source.path) + ',' + JSON.stringify(source.cwd) + ')')
      }
      console.log('Handoff phase ' + phase + ' passed')
      app.quit()
    } catch (error) { console.error(error); app.quit() }
  })
})
require(path.join(root, 'apps/desktop/out/main/index.js'))
