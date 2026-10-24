/**
 * Composer behaviour while a turn is streaming:
 * - Enter steers (the message joins the run), Ctrl+Enter queues it for afterwards
 * - queued messages render above the composer box, not inside it, with a 「引导」 button
 */
const assert = require('node:assert/strict')

module.exports = async function queueSmoke(evaluate, until, window) {
  const idle = await evaluate('window.pi.getStatus()')
  window.webContents.send('pi:status', { ...idle, isStreaming: true })
  await until(() => evaluate('!!document.querySelector(".composer textarea")'), 'composer')
  await new Promise((resolve) => setTimeout(resolve, 300))

  const placeholder = await evaluate('document.querySelector(".composer textarea").placeholder')
  assert.match(placeholder, /Enter 引导/, 'Enter steers while a run is streaming')
  assert.match(placeholder, /Ctrl\+Enter 排队/, 'Ctrl+Enter queues instead')
  assert.match(
    await evaluate('document.querySelector(".composer-hint").textContent'),
    /Ctrl\+Enter 排队/
  )

  await evaluate(`
    (() => {
      const area = document.querySelector('.composer textarea')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(area, '队列里的这条')
      area.dispatchEvent(new Event('input', { bubbles: true }))
      area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))
    })()
  `)
  await until(() => evaluate('!!document.querySelector(".queue-panel")'), 'queue panel')
  assert.equal(
    await evaluate('!!document.querySelector(".composer .queue-panel")'),
    false,
    'the queue lives outside the composer box'
  )
  assert.equal(await evaluate('!!document.querySelector(".composer-wrap > .queue-panel")'), true)
  assert.equal(
    await evaluate('document.querySelector(".queue-text").textContent'),
    '队列里的这条'
  )
  const steer = await evaluate(`(() => {
    const button = document.querySelector('.queue-steer')
    return button ? button.textContent.trim() : null
  })()`)
  assert.equal(steer, '引导', 'a queued message can be turned into an immediate steer')

  // Leave no queued message behind for the steps that follow.
  await evaluate('document.querySelector(".queue-item .queue-btn:last-child").click()')
  await until(() => evaluate('!document.querySelector(".queue-panel")'), 'queue cleared')
  window.webContents.send('pi:status', idle)
  console.log('Composer passed: Enter steers, Ctrl+Enter queues, queue sits above the composer')
}
