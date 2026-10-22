import { useEffect, useState } from 'react'
import { CloseIcon } from './Icons'
import { imageSrc, type DraftImage } from '../lib/images'
import type { MessageImage } from '../lib/messages'

export function ImageLightbox({
  src,
  alt,
  onClose
}: {
  src: string
  alt?: string
  onClose: () => void
}): React.JSX.Element {
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [onClose])

  return (
    <div
      className="image-lightbox"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <button className="icon-btn image-lightbox-close" onClick={onClose} title="关闭 (Esc)">
        <CloseIcon size={15} />
      </button>
      <img src={src} alt={alt ?? '图片'} />
    </div>
  )
}

export function MessageImages({
  images,
  align = 'start'
}: {
  images: MessageImage[]
  align?: 'start' | 'end'
}): React.JSX.Element | null {
  const [preview, setPreview] = useState<MessageImage>()
  if (images.length === 0) return null
  return (
    <>
      <div className={`message-images ${align}`}>
        {images.map((image, index) => (
          <button
            key={`${index}-${image.data.slice(0, 12)}`}
            className="message-image"
            onClick={() => setPreview(image)}
            title="查看大图"
          >
            <img src={imageSrc(image)} alt={`图片${index + 1}`} />
          </button>
        ))}
      </div>
      {preview && (
        <ImageLightbox src={imageSrc(preview)} onClose={() => setPreview(undefined)} />
      )}
    </>
  )
}

export function DraftImageStrip({
  images,
  placement,
  onRemove,
  onPreview
}: {
  images: DraftImage[]
  placement: DraftImage['placement']
  onRemove: (id: string) => void
  onPreview: (image: DraftImage) => void
}): React.JSX.Element | null {
  const list = images.filter((image) => image.placement === placement)
  if (list.length === 0) return null
  return (
    <div className={`draft-images ${placement}`}>
      {list.map((image) => {
        const index = images.indexOf(image)
        return (
          <div key={image.id} className="draft-image">
            <button
              className="draft-image-thumb"
              onClick={() => onPreview(image)}
              title={`${image.name ?? `图片${index + 1}`} · 点击查看`}
            >
              <img src={imageSrc(image)} alt={`图片${index + 1}`} />
            </button>
            <span className="draft-image-label">
              {placement === 'inline' ? `图片${index + 1}` : image.name ?? '图片'}
            </span>
            <button
              className="draft-image-remove"
              onClick={() => onRemove(image.id)}
              title="移除图片"
            >
              <CloseIcon size={10} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
