import html2canvas from 'html2canvas'
import { jsPDF } from 'jspdf'

const WHITE_RGB_THRESHOLD = 246
const BLANK_ROW_MAX_INK_RATIO = 0.014
const SCAN_WINDOW_PX = 120
const ROW_SAMPLE_STRIDE = 4
const BLOCK_ROW_PENALTY = 0.7

function getRowInkRatio(ctx: CanvasRenderingContext2D, width: number, y: number): number {
  const row = ctx.getImageData(0, y, width, 1).data
  let sampled = 0
  let inked = 0

  for (let x = 0; x < width; x += ROW_SAMPLE_STRIDE) {
    const i = x * 4
    const r = row[i]
    const g = row[i + 1]
    const b = row[i + 2]
    const a = row[i + 3]
    sampled += 1

    if (a > 10 && (r < WHITE_RGB_THRESHOLD || g < WHITE_RGB_THRESHOLD || b < WHITE_RGB_THRESHOLD)) {
      inked += 1
    }
  }

  return sampled > 0 ? inked / sampled : 0
}

function collectBlockRanges(element: HTMLElement, scaleY: number): Array<{ top: number; bottom: number }> {
  const rootRect = element.getBoundingClientRect()
  const blockNodes = element.querySelectorAll<HTMLElement>('h1,h2,h3,p,ul,ol,li,hr,blockquote,table,pre')
  const ranges: Array<{ top: number; bottom: number }> = []

  blockNodes.forEach((node) => {
    const rect = node.getBoundingClientRect()
    const top = Math.floor((rect.top - rootRect.top) * scaleY)
    const bottom = Math.ceil((rect.bottom - rootRect.top) * scaleY)
    if (Number.isFinite(top) && Number.isFinite(bottom) && bottom - top >= 2) {
      ranges.push({ top, bottom })
    }
  })

  return ranges
}

function isInsideBlockRow(y: number, blockRanges: Array<{ top: number; bottom: number }>): boolean {
  for (const r of blockRanges) {
    if (y >= r.top + 2 && y <= r.bottom - 2) return true
  }
  return false
}

function findBreakRow(
  ctx: CanvasRenderingContext2D,
  width: number,
  startY: number,
  idealEndY: number,
  maxY: number,
  minSliceHeightPx: number,
  blockRanges: Array<{ top: number; bottom: number }>,
): number {
  const minAllowedY = Math.max(startY + minSliceHeightPx, 0)
  const scanStart = Math.max(idealEndY - SCAN_WINDOW_PX, minAllowedY)
  const scanEnd = Math.min(idealEndY + SCAN_WINDOW_PX, maxY)

  let bestY = idealEndY
  let bestScore = Number.POSITIVE_INFINITY

  for (let y = scanStart; y <= scanEnd; y += 1) {
    const ink = getRowInkRatio(ctx, width, y)
    const distancePenalty = Math.abs(y - idealEndY) / SCAN_WINDOW_PX
    const blockPenalty = isInsideBlockRow(y, blockRanges) ? BLOCK_ROW_PENALTY : 0
    const score = ink + distancePenalty * 0.18 + blockPenalty

    if (score < bestScore) {
      bestScore = score
      bestY = y
      if (ink <= BLANK_ROW_MAX_INK_RATIO && blockPenalty === 0 && distancePenalty < 0.08) {
        break
      }
    }
  }

  return bestY
}

/**
 * Rasterize a DOM node (the same resume preview the user edits) into a multi-page A4 PDF.
 *
 * Instead of re-drawing one huge image with negative Y offsets (which can cut through text lines),
 * we slice the canvas per page and look for a nearby low-ink row before each page break.
 */
export async function buildResumePdfFromElement(element: HTMLElement): Promise<Blob> {
  const canvas = await html2canvas(element, {
    scale: 2,
    useCORS: true,
    allowTaint: false,
    logging: false,
    backgroundColor: '#ffffff',
    windowWidth: element.scrollWidth,
    windowHeight: element.scrollHeight,
  })

  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Unable to read rendered resume canvas')

  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
  const pageWidthMm = pdf.internal.pageSize.getWidth()
  const pageHeightMm = pdf.internal.pageSize.getHeight()

  const pageHeightPx = Math.floor((canvas.width * pageHeightMm) / pageWidthMm)
  const minSliceHeightPx = Math.floor(pageHeightPx * 0.6)
  const scaleY = canvas.height / Math.max(element.scrollHeight, 1)
  const blockRanges = collectBlockRanges(element, scaleY)

  let startY = 0
  let pageIndex = 0

  while (startY < canvas.height) {
    const idealEndY = Math.min(startY + pageHeightPx, canvas.height)
    let endY = idealEndY

    if (idealEndY < canvas.height) {
      endY = findBreakRow(ctx, canvas.width, startY, idealEndY, canvas.height - 1, minSliceHeightPx, blockRanges)
    }

    if (endY <= startY) break

    const sliceHeightPx = endY - startY
    const pageCanvas = document.createElement('canvas')
    pageCanvas.width = canvas.width
    pageCanvas.height = sliceHeightPx

    const pageCtx = pageCanvas.getContext('2d')
    if (!pageCtx) throw new Error('Unable to render PDF page slice')

    pageCtx.fillStyle = '#ffffff'
    pageCtx.fillRect(0, 0, pageCanvas.width, pageCanvas.height)
    pageCtx.drawImage(canvas, 0, startY, canvas.width, sliceHeightPx, 0, 0, canvas.width, sliceHeightPx)

    const pageImgData = pageCanvas.toDataURL('image/jpeg', 0.94)
    const renderedHeightMm = (sliceHeightPx * pageWidthMm) / canvas.width

    if (pageIndex > 0) pdf.addPage()
    pdf.addImage(pageImgData, 'JPEG', 0, 0, pageWidthMm, renderedHeightMm)

    startY = endY
    pageIndex += 1
  }

  return pdf.output('blob')
}
