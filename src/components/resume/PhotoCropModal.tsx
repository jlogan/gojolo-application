import { useCallback, useState } from 'react'
import Cropper, { type Area } from 'react-easy-crop'

type Props = {
  imageSrc: string
  open: boolean
  onClose: () => void
  onCropped: (blob: Blob) => void
  title?: string
}

/** Create an HTMLImageElement from a data URL or remote URL */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.addEventListener('load', () => resolve(img))
    img.addEventListener('error', () => reject(new Error('Failed to load image')))
    img.setAttribute('crossOrigin', 'anonymous')
    img.src = src
  })
}

/** Render cropped region to a square JPEG blob (fixed output size for resumes). */
async function getCroppedSquareBlob(imageSrc: string, pixelCrop: Area, outputSize = 512): Promise<Blob> {
  const image = await loadImage(imageSrc)
  const canvas = document.createElement('canvas')
  canvas.width = outputSize
  canvas.height = outputSize
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No canvas context')

  ctx.drawImage(
    image,
    pixelCrop.x,
    pixelCrop.y,
    pixelCrop.width,
    pixelCrop.height,
    0,
    0,
    outputSize,
    outputSize,
  )

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob)
        else reject(new Error('Could not create image blob'))
      },
      'image/jpeg',
      0.92,
    )
  })
}

export function PhotoCropModal({ imageSrc, open, onClose, onCropped, title = 'Crop photo (square)' }: Props) {
  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null)
  const [busy, setBusy] = useState(false)

  const onCropComplete = useCallback((_area: Area, areaPixels: Area) => {
    setCroppedAreaPixels(areaPixels)
  }, [])

  const handleSave = async () => {
    if (!croppedAreaPixels) return
    setBusy(true)
    try {
      const blob = await getCroppedSquareBlob(imageSrc, croppedAreaPixels)
      onCropped(blob)
      onClose()
    } catch (e) {
      alert((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/70">
      <div className="bg-surface-elevated border border-border rounded-xl max-w-lg w-full p-4 shadow-xl">
        <h2 className="text-lg font-medium text-white mb-1">{title}</h2>
        <p className="text-xs text-gray-400 mb-3">Drag to reposition. Pinch or use the slider to zoom. Output is a square image for your resume.</p>

        <div className="relative w-full aspect-square max-h-[min(70vh,360px)] mx-auto bg-black rounded-lg overflow-hidden mb-3">
          <Cropper
            image={imageSrc}
            crop={crop}
            zoom={zoom}
            aspect={1}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={onCropComplete}
          />
        </div>

        <label className="flex items-center gap-2 text-sm text-gray-300 mb-4">
          <span className="shrink-0 w-14">Zoom</span>
          <input
            type="range"
            min={1}
            max={3}
            step={0.05}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="flex-1 accent-accent"
          />
        </label>

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-2 rounded-lg border border-border text-gray-200 hover:bg-surface-muted">
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !croppedAreaPixels}
            onClick={handleSave}
            className="px-3 py-2 rounded-lg bg-accent text-accent-foreground disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Use cropped photo'}
          </button>
        </div>
      </div>
    </div>
  )
}
