import { clipboard, ClipboardItem, nativeImage } from 'electron'
import { MAX_CLIPBOARD_IMAGE_PIXELS, MAX_CLIPBOARD_PNG_BYTES } from '../shared/image-clipboard'

/** Accept only renderer-rasterized PNG bytes; never read a file or fetch a URL. */
export async function copyImageToClipboard(dataUrl: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const prefix = 'data:image/png;base64,'
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix)) {
      throw new Error('只能复制 PNG 图片数据')
    }
    if (dataUrl.length > prefix.length + Math.ceil(MAX_CLIPBOARD_PNG_BYTES / 3) * 4) {
      throw new Error('图片过大，无法复制')
    }
    const encoded = dataUrl.slice(prefix.length)
    if (!encoded || encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded)) {
      throw new Error('图片数据无效')
    }
    const png = Buffer.from(encoded, 'base64')
    // Inspect IHDR before native decoding to reject decompression bombs.
    if (png.length < 33 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
        png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR') {
      throw new Error('图片数据无效')
    }
    const width = png.readUInt32BE(16)
    const height = png.readUInt32BE(20)
    if (!width || !height || width * height > MAX_CLIPBOARD_IMAGE_PIXELS) {
      throw new Error('图片尺寸过大或无效，无法复制')
    }
    const image = nativeImage.createFromBuffer(png)
    if (image.isEmpty()) throw new Error('图片解码失败')
    await clipboard.write([new ClipboardItem({
      'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' })
    })])
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '复制图片失败' }
  }
}
