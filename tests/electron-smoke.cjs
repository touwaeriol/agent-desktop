const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const path = require('node:path')
const root = process.env.PROPHEY_SMOKE_ROOT
const desktop = process.env.PROPHEY_SMOKE_APP || path.join(root, 'apps/desktop')
app.setPath('userData', process.env.PROPHEY_SMOKE_DATA)
app.setAppPath(desktop)
// Exercise the real renderer without interrupting the user's desktop.
BrowserWindow.prototype.show = function () {}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(probe, label) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await probe()
    if (value) return value
    await delay(100)
  }
  throw Error('Timed out: ' + label)
}
app.on('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', async () => {
    const evaluate = source => window.webContents.executeJavaScript(source)
    try {
      await until(() => evaluate('window.pi.getStatus().then(s => s.phase === "ready")'), 'engine ready')
      const config = await evaluate('window.pi.getDesktopConfig()')
      assert.equal(config.engine, 'prophey')
      assert.equal(config.profile, 'desktop')
      assert.equal(config.capabilities.autoCompaction, 'configurable')
      assert.equal((await evaluate('window.pi.getStatus()')).autoCompactPercent, 0.1)
      assert.equal((await evaluate('window.pi.setAutoCompactRatio(75)')).ok, true)
      assert.equal((await evaluate('window.pi.getStatus()')).autoCompactPercent, 75)
      assert.equal((await evaluate('window.pi.setCompactThreshold(NaN)')).ok, false)
      const commands = await evaluate('window.pi.getEngineCommands()')
      assert(commands.some(command => command.name === '/compact'))
      assert(!commands.some(command => command.name === '/thinking'))
      assert.equal((await evaluate('window.pi.executeEngineCommand("/unknown", "")')).ok, false)
      assert.equal((await evaluate('window.pi.executeEngineCommand("/status", "")')).ok, true)
      await until(() => evaluate('!!document.querySelector(".attach-btn")'), 'composer')
      await evaluate('document.querySelector(".attach-btn").click()')
      await until(() => evaluate('!!document.querySelector(".context-picker")'), 'context menu')
      await evaluate('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))')
      await until(() => evaluate('!document.querySelector(".context-picker")'), 'Escape dismiss')
      await evaluate('document.querySelector("button[title=设置]").click()')
      await until(() => evaluate('!!document.querySelector(".settings")'), 'settings dialog')
      const nav = await evaluate('Array.from(document.querySelectorAll(".settings-nav button"), b => b.textContent).join(" ")')
      assert.match(nav, /服务商/)
      assert.match(nav, /MCP/)
      await evaluate('document.querySelector(".modal-backdrop").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))')
      await until(() => evaluate('!document.querySelector(".settings")'), 'settings dismiss')
      const pi = await evaluate('window.pi.setEngine("pi")')
      assert.equal(pi.phase, 'ready')
      assert.equal(pi.engine, 'pi')
      assert((await evaluate('window.pi.getEngineCommands()')).some(c => c.name === '/thinking'))
      const own = await evaluate('window.pi.setEngine("prophey")')
      assert.equal(own.phase, 'ready')
      assert.equal(own.engine, 'prophey')
      const version = (await evaluate('window.pi.getUpdateSnapshot()')).currentVersion
      assert.equal(version, require(path.join(desktop, 'package.json')).version)
      console.log('Electron smoke passed: isolated startup, IPC, compaction, command menus, settings, dismissal, pi/Prophey switching, version ' + version)
      app.quit()
    } catch (error) {
      console.error(error)
      process.exitCode = 1
      app.quit()
    }
  })
})
require(path.join(desktop, 'out/main/index.js'))
