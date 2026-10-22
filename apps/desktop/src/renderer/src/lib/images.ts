export interface DraftImage {
  id: string
  data: string
  mimeType: string
  name?: string
}

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024

export function imageSrc(image: { data: string; mimeType: string }): string {
  return `data:${image.mimeType || 'image/png'};base64,${image.data}`
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'))
    reader.readAsDataURL(blob)
  })
}

export async function blobToDraftImage(blob: Blob, name?: string): Promise<DraftImage | null> {
  if (blob.size > MAX_IMAGE_BYTES) return null
  const dataUrl = await readAsDataUrl(blob)
  const comma = dataUrl.indexOf(',')
  if (comma === -1) return null
  const mimeType = /^data:([^;]+)/.exec(dataUrl)?.[1] ?? blob.type ?? 'image/png'
  return {
    id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    data: dataUrl.slice(comma + 1),
    mimeType,
    ...(name ? { name } : {})
  }
}

export function clipboardImages(data: DataTransfer | null): File[] {
  if (!data) return []
  const files: File[] = []
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file) files.push(file)
  }
  return files
}
