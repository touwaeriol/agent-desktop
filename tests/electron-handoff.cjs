const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = process.env.PROPHEY_HANDOFF_ROOT, temp = process.env.PROPHEY_HANDOFF_TEMP
const native = process.env.PROPHEY_HANDOFF_NATIVE === '1', phase = Number(process.env.PROPHEY_HANDOFF_PHASE)
app.setPath('userData', path.join(temp, 'user-data'))
app.setAppPath(path.join(root, 'apps/desktop'))
BrowserWindow.prototype.show = function () {}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(probe, label) { for (let i = 0; i < 300; i++) { if (await probe()) return; await delay(100) } throw Error('Timed out: ' + label) }
app.on('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', async () => {
    const run = source => window.webContents.executeJavaScript(source)
    const snapshot = () => run('window.pi.getMessages()')
    async function checkHistory() {
      const rows = await snapshot(), text = JSON.stringify(rows)
      assert(text.includes('ORCHID-731'), 'source text missing')
      assert(!text.includes('PRIVATE_'), 'thoughts or signatures crossed engines')
      assert(rows.some(m => m.role === 'toolResult'), 'tool result missing')
      assert(rows.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'image')), 'image missing')
      await until(() => run('document.querySelector(".chat-column")?.textContent.includes("ORCHID-731")'), 'visible imported conversation')
      return rows
    }
    async function switchTo(id) {
      const next = await run('window.pi.setEngine(' + JSON.stringify(id) + ')')
      assert.equal(next.phase, 'ready'); assert.equal(next.engine, id)
      assert.equal(next.cwd, path.join(temp, 'workspace'))
      await checkHistory()
      await until(() => run('document.querySelector(".engine-picker select")?.value === ' + JSON.stringify(id)), 'picker ' + id)
    }
    try {
      await until(() => run('window.pi.getStatus().then(s => s.phase === "ready")'), 'initial ready')
      if (phase === 1) {
        assert(JSON.stringify(await snapshot()).includes('PRIVATE_THOUGHT_SENTINEL'))
        await until(() => run('!!document.querySelector(".engine-picker select")'), 'picker')
        await run('const picker = document.querySelector(".engine-picker select"); picker.value = "pi"; picker.dispatchEvent(new Event("change", { bubbles: true }))')
        await until(() => run('window.pi.getStatus().then(s => s.engine === "pi" && s.phase === "ready")'), 'UI switch')
        await checkHistory()
        const firstKey = path.join(temp, 'user-data', 'transcripts', 's_source.jsonl')
        const secondKey = path.join(temp, 'user-data', 'transcripts', 's_second.jsonl')
        assert.equal((await run('window.pi.getStatus()')).sessionKey, firstKey)
        let sessions = await run('window.pi.listSessions()')
        assert.equal(sessions.length, 2, 'changing engines must not duplicate the conversation')
        assert.equal(sessions.find(s => s.path === firstKey).engine, 'pi')
        assert.equal(sessions.find(s => s.path === secondKey).engine, 'prophey')
        assert.equal((await run('window.pi.getDesktopConfig()')).defaultEngine, 'prophey')
        await until(() => run('Array.from(document.querySelectorAll(".session-title")).some(e => e.textContent === "SECOND SESSION")'), 'second session in sidebar')
        await run('Array.from(document.querySelectorAll(".session-title")).find(e => e.textContent === "SECOND SESSION").click()')
        await until(() => run('window.pi.getStatus().then(s => s.phase === "ready" && s.engine === "prophey")'), 'same-directory session restores its own engine')
        assert(JSON.stringify(await snapshot()).includes('SECOND_SESSION_SENTINEL'))
        await run('window.pi.setDefaultEngine("pi")')
        assert.equal((await run('window.pi.getStatus()')).engine, 'prophey', 'default must not replace the active engine')
        assert.equal((await run('window.pi.newSession()')).ok, true)
        assert.equal((await run('window.pi.getStatus()')).engine, 'pi')
        assert.equal((await snapshot()).length, 0, 'new session must not reuse the previous transcript')
        await run('window.pi.setDefaultEngine("prophey")')
        await run('window.pi.openSession(' + JSON.stringify(firstKey) + ',' + JSON.stringify(path.join(temp, 'workspace')) + ')')
        assert.equal((await run('window.pi.getStatus()')).engine, 'pi')
        await checkHistory()
        if (native) {
          const competing = await run('(async () => { const first = window.pi.setEngine("claude"); const second = window.pi.setEngine("codex").then(() => false, () => true); await first; return await second })()')
          assert.equal(competing, true, 'concurrent engine changes must be rejected')
          await checkHistory()
          assert.equal((await run('window.pi.prompt("Continue the history proof.")')).ok, true)
          await switchTo('codex')
          assert.equal((await run('window.pi.prompt("Continue the history proof.")')).ok, true)
          await run('window.handoffPending = window.pi.prompt("__HOLD__").catch(error => ({ ok: false, error: String(error) })); void 0')
          await until(() => run('window.pi.getStatus().then(s => s.isStreaming)'), 'busy turn')
          assert.equal(await run('document.querySelector(".engine-picker select").disabled'), false)
          await switchTo('pi')
          await run('window.handoffPending')
          await switchTo('codex'); await switchTo('claude')
        } else await switchTo('prophey')
      } else {
        await checkHistory()
        const restoredSessions = await run('window.pi.listSessions()')
        assert.equal(restoredSessions.find(s => s.title === 'SECOND SESSION').engine, 'prophey')
        assert.equal((await run('window.pi.getDesktopConfig()')).defaultEngine, 'prophey')
        if (native && phase === 2) {
          assert.equal((await run('window.pi.getStatus()')).engine, 'claude')
          await switchTo('codex')
          assert.equal((await run('window.pi.prompt("Check resumed context.")')).ok, true)
        } else {
          if (native) assert.equal((await run('window.pi.getStatus()')).engine, 'codex')
          await switchTo('prophey')
          const before = await run('window.pi.getStatus()')
          const appdata = process.env.APPDATA, search = process.env.PATH
          process.env.APPDATA = path.join(temp, 'absent'); process.env.PATH = ''
          try { await assert.rejects(run('window.pi.setEngine("claude")'), /未切换|失败|ENOENT/) }
          finally { process.env.APPDATA = appdata; process.env.PATH = search }
          const after = await run('window.pi.getStatus()')
          assert.equal(after.engine, 'prophey'); assert.equal(after.phase, 'ready')
          assert.equal(after.sessionFile, before.sessionFile)
          await checkHistory()
        }
      }
      if (native && phase === 3) {
        const requests = JSON.parse(fs.readFileSync(path.join(temp, 'requests.json'), 'utf8')).filter(r => !r.counted && !r.hold)
        for (const kind of ['claude', 'codex']) {
          const request = requests.find(r => r.kind === kind && JSON.stringify(r.body).includes('ORCHID-731'))
          assert(request, kind + ' did not receive imported history')
          assert(!JSON.stringify(request.body).includes('PRIVATE_'))
          const data = JSON.stringify(request.body.messages ?? request.body.input)
          assert(data.includes(kind === 'claude' ? 'tool_use' : 'function_call'))
          assert(data.includes(kind === 'claude' ? 'tool_result' : 'function_call_output'))
        }
      }
      console.log('Handoff phase ' + phase + ' passed')
      app.quit()
    } catch (error) { console.error(error); app.quit() }
  })
})
require(path.join(root, 'apps/desktop/out/main/index.js'))
