/**
 * Starting another session while a turn is streaming must not dead-end on “请先停止当前回合”:
 * the window asks first, and only then does the main process stop the run and switch.
 */
const assert = require('node:assert/strict')

module.exports = async function sessionSwitchSmoke(evaluate, until, window) {
  const idle = await evaluate('window.pi.getStatus()')
  // The renderer decides from the status it has, so a streaming status is enough to open the dialog.
  window.webContents.send('pi:status', { ...idle, isStreaming: true })
  await until(() => evaluate('window.pi.getStatus()'), 'status broadcast')

  const newInRepo =
    'Array.from(document.querySelectorAll(".sidebar button")).find((b) => /^在 .+ 新建会话$/.test(b.title))'
  assert.equal(await evaluate(newInRepo + ' !== undefined'), true, 'the sidebar has a per-repository + button')

  await evaluate(newInRepo + '.click()')
  await until(() => evaluate('!!document.querySelector(".confirm-dialog")'), 'confirm dialog while a turn runs')
  assert.match(await evaluate('document.querySelector(".confirm-dialog").textContent'), /当前回合仍在运行/)
  assert.match(await evaluate('document.querySelector(".confirm-dialog").textContent'), /停止并/)

  // Cancelling keeps everything as it was: no new session, the run is not stopped.
  await evaluate(
    'Array.from(document.querySelectorAll(".confirm-actions button")).find((b) => b.textContent === "取消").click()'
  )
  await until(() => evaluate('!document.querySelector(".confirm-dialog")'), 'cancel closes the dialog')
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(
    await evaluate('window.pi.getStatus().then((s) => s.sessionFile)'),
    idle.sessionFile,
    'cancelling does not create a session'
  )

  // Confirming stops the run and lands in a fresh session.
  await evaluate(newInRepo + '.click()')
  await until(() => evaluate('!!document.querySelector(".confirm-dialog")'), 'confirm dialog again')
  await evaluate('document.querySelector(".confirm-actions .danger").click()')
  await until(
    () =>
      evaluate(
        'window.pi.getStatus().then((s) => s.phase === "ready" && s.sessionFile !== ' +
          JSON.stringify(idle.sessionFile) +
          ')'
      ),
    'new session after confirming'
  )
  assert.equal(await evaluate('document.querySelectorAll(".confirm-dialog").length'), 0)
  console.log('Session switch passed: running turn is confirmed before the session is replaced')
}
