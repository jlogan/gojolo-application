import html2canvas from 'html2canvas'
import { jsPDF } from 'jspdf'

/**
 * Generate a PDF blob from an invoice detail element.
 *
 * Renders the provided HTML element to a high-res canvas, then places it
 * on an A4 page (portrait). For multi-page invoices the element is split
 * into pages automatically based on scroll height.
 *
 * Pattern mirrors src/lib/resumePdf.ts.
 */
export async function generateInvoicePdf(
  element: HTMLElement,
  filename?: string,
): Promise<{ blob: Blob; filename: string }> {
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
  const pageWidthMm = pdf.internal.pageSize.getWidth()
  const pageHeightMm = pdf.internal.pageSize.getHeight()

  // Measure the element
  const rect = element.getBoundingClientRect()
  const elWidthPx = Math.max(rect.width, element.scrollWidth, 1)
  const elHeightPx = Math.max(rect.height, element.scrollHeight, 1)

  // Calculate how many pages we need
  const pageHeightPx = Math.ceil(elWidthPx * (pageHeightMm / pageWidthMm))
  const totalPages = Math.max(1, Math.ceil(elHeightPx / pageHeightPx))

  // Create an offscreen clone so we can manipulate it without affecting the UI
  const host = document.createElement('div')
  host.style.position = 'fixed'
  host.style.left = '-20000px'
  host.style.top = '0'
  host.style.width = `${elWidthPx}px`
  host.style.opacity = '0'
  host.style.pointerEvents = 'none'
  host.style.zIndex = '-1'
  document.body.appendChild(host)

  const clone = element.cloneNode(true) as HTMLElement
  clone.style.width = `${elWidthPx}px`
  clone.style.background = '#ffffff'
  clone.style.color = '#111827'
  // Override dark-mode text colors for PDF readability
  clone.querySelectorAll('*').forEach((el) => {
    const htmlEl = el as HTMLElement
    const computed = window.getComputedStyle(htmlEl)
    if (computed.color) {
      // Keep badge/status colors but convert grays/whites to dark
      const c = computed.color
      // Very light text -> dark
      if (c === 'rgb(255, 255, 255)' || c === 'rgba(255, 255, 255, 1)') {
        htmlEl.style.color = '#111827'
      }
    }
  })
  host.appendChild(clone)

  try {
    if (totalPages === 1) {
      // Single-page — render the whole element
      const canvas = await html2canvas(clone, {
        scale: 2,
        useCORS: true,
        allowTaint: false,
        logging: false,
        backgroundColor: '#ffffff',
        windowWidth: elWidthPx,
        windowHeight: elHeightPx,
      })

      const imgData = canvas.toDataURL('image/jpeg', 0.94)
      const imgHeightMm = (canvas.height / canvas.width) * pageWidthMm
      pdf.addImage(imgData, 'JPEG', 0, 0, pageWidthMm, Math.min(imgHeightMm, pageHeightMm))
    } else {
      // Multi-page — render in slices
      for (let page = 0; page < totalPages; page++) {
        const yOffset = page * pageHeightPx

        // Create a wrapper that clips to the current page slice
        const slice = document.createElement('div')
        slice.style.width = `${elWidthPx}px`
        slice.style.height = `${pageHeightPx}px`
        slice.style.overflow = 'hidden'
        slice.style.position = 'relative'
        slice.style.background = '#ffffff'

        const inner = clone.cloneNode(true) as HTMLElement
        inner.style.position = 'absolute'
        inner.style.top = `-${yOffset}px`
        inner.style.left = '0'
        slice.appendChild(inner)
        host.appendChild(slice)

        const canvas = await html2canvas(slice, {
          scale: 2,
          useCORS: true,
          allowTaint: false,
          logging: false,
          backgroundColor: '#ffffff',
          windowWidth: elWidthPx,
          windowHeight: pageHeightPx,
        })

        const imgData = canvas.toDataURL('image/jpeg', 0.94)
        if (page > 0) pdf.addPage()
        pdf.addImage(imgData, 'JPEG', 0, 0, pageWidthMm, pageHeightMm)

        host.removeChild(slice)
      }
    }
  } finally {
    host.remove()
  }

  const safeName = filename || 'invoice.pdf'
  const blob = pdf.output('blob')

  return { blob, filename: safeName }
}

/**
 * Convenience: generate and immediately trigger browser download.
 */
export async function downloadInvoicePdf(
  element: HTMLElement,
  filename?: string,
): Promise<void> {
  const { blob, filename: name } = await generateInvoicePdf(element, filename)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
