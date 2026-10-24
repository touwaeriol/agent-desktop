const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const vm = require('node:vm')
const esbuild = require('esbuild')
const code = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../apps/desktop/src/main/image-clipboard.ts')],
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'], write: false
}).outputFiles[0].text
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=', 'base64')
const url = bytes => 'data:image/png;base64,' + bytes.toString('base64')
function fixture({ empty = false, failWrite = false } = {}) {
  const calls = []
  const image = { isEmpty: () => empty, toPNG: () => png }
  const module = { exports: {} }
  vm.runInNewContext(code, { module, exports: module.exports, Buffer, Blob, require(name) {
    assert.equal(name, 'electron')
    return {
      nativeImage: { createFromBuffer(bytes) { calls.push(['decode', bytes]); return image } },
      ClipboardItem: class { constructor(data) { this.data = data } },
      clipboard: { async write(value) { calls.push(['write', value]); if (failWrite) throw Error('clipboard unavailable') } }
    }
  } })
  return { copy: module.exports.copyImageToClipboard, calls }
}
test('image clipboard: valid PNG writes an image, never a URL or text', async () => {
  const { copy, calls } = fixture()
  assert.equal((await copy(url(png))).ok, true)
  assert.deepEqual(calls[0], ['decode', png])
  const blob = calls[1][1][0].data['image/png']
  assert.equal(blob.type, 'image/png')
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), png)
})
test('image clipboard: invalid types, URLs and malformed PNG never reach the native decoder', async () => {
  const { copy, calls } = fixture()
  for (const input of [null, {}, 12, 'file:///secret.png', 'https://example.com/a.png',
    'data:image/jpeg;base64,AAAA', 'data:image/png;base64,!!!!', 'data:image/png;base64,AAAA',
    url(Buffer.alloc(33))]) {
    const result = await copy(input)
    assert.equal(result.ok, false)
    assert(result.error)
  }
  assert.equal(calls.length, 0)
})
test('image clipboard: rejects oversized or zero-sized IHDR before decoding', async () => {
  const { copy, calls } = fixture()
  for (const [width, height] of [[0, 1], [1, 0], [100000, 100000], [0xffffffff, 0xffffffff]]) {
    const bytes = Buffer.from(png)
    bytes.writeUInt32BE(width, 16)
    bytes.writeUInt32BE(height, 20)
    assert.equal((await copy(url(bytes))).ok, false)
  }
  assert.equal(calls.length, 0)
})
test('image clipboard: decode and OS write failures return errors, never success', async () => {
  const empty = fixture({ empty: true })
  assert.equal((await empty.copy(url(png))).ok, false)
  assert.equal(empty.calls.length, 1)
  const unavailable = fixture({ failWrite: true })
  assert.equal((await unavailable.copy(url(png))).ok, false)
})
