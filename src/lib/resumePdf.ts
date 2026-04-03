import html2canvas from 'html2canvas'
import { jsPDF } from 'jspdf'

type PaginatedPages = {
  pages: HTMLElement[]
  cleanup: () => void
}

function paginateResumeElement(element: HTMLElement): PaginatedPages {
  const sourceProse = element.querySelector('.ProseMirror') as HTMLElement | null
  if (!sourceProse) {
    return { pages: [element], cleanup: () => {} }
  }

  const pageWidthPx = Math.max(Math.ceil(element.getBoundingClientRect().width), element.scrollWidth, 1)
  const pageHeightPx = Math.ceil(pageWidthPx * (297 / 210))

  const proseStyles = window.getComputedStyle(sourceProse)
  const paddingTop = parseFloat(proseStyles.paddingTop || '0')
  const paddingBottom = parseFloat(proseStyles.paddingBottom || '0')
  const maxContentHeight = Math.max(1, Math.floor(pageHeightPx - paddingTop - paddingBottom))

  const host = document.createElement('div')
  host.style.position = 'fixed'
  host.style.left = '-20000px'
  host.style.top = '0'
  host.style.width = `${pageWidthPx}px`
  host.style.opacity = '0'
  host.style.pointerEvents = 'none'
  host.style.zIndex = '-1'
  document.body.appendChild(host)

  const createPage = () => {
    const page = document.createElement('div')
    page.className = element.className
    page.style.width = `${pageWidthPx}px`
    page.style.height = `${pageHeightPx}px`
    page.style.minHeight = `${pageHeightPx}px`
    page.style.background = '#ffffff'
    page.style.boxSizing = 'border-box'
    page.style.overflow = 'hidden'
    page.style.border = 'none'
    page.style.boxShadow = 'none'

    const prose = document.createElement('div')
    prose.className = sourceProse.className
    page.appendChild(prose)
    host.appendChild(page)
    return { page, prose }
  }

  const pages: HTMLDivElement[] = []
  let current = createPage()

  const sourceChildren = Array.from(sourceProse.children)
  if (sourceChildren.length === 0) {
    current.prose.innerHTML = sourceProse.innerHTML
    pages.push(current.page)
    return {
      pages,
      cleanup: () => {
        host.remove()
      },
    }
  }

  for (const child of sourceChildren) {
    const clone = child.cloneNode(true) as HTMLElement
    current.prose.appendChild(clone)

    if (current.prose.scrollHeight > maxContentHeight && current.prose.children.length > 1) {
      current.prose.removeChild(clone)
      pages.push(current.page)

      current = createPage()
      current.prose.appendChild(clone)
    }
  }

  if (current.prose.children.length > 0 || pages.length === 0) {
    pages.push(current.page)
  }

  return {
    pages,
    cleanup: () => {
      host.remove()
    },
  }
}

/**
 * Render the editable resume preview to an A4 PDF without cutting text lines.
 *
 * Strategy:
 * 1) Paginate DOM blocks (paragraphs/list items/headings) into virtual A4 pages.
 * 2) Rasterize each page separately.
 * 3) Insert one image per PDF page.
 */
export async function buildResumePdfFromElement(element: HTMLElement): Promise<Blob> {
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
  const pageWidthMm = pdf.internal.pageSize.getWidth()
  const pageHeightMm = pdf.internal.pageSize.getHeight()

  const { pages, cleanup } = paginateResumeElement(element)

  try {
    for (let i = 0; i < pages.length; i += 1) {
      const page = pages[i]
      const canvas = await html2canvas(page, {
        scale: 2,
        useCORS: true,
        allowTaint: false,
        logging: false,
        backgroundColor: '#ffffff',
        windowWidth: page.scrollWidth,
        windowHeight: page.scrollHeight,
      })

      const imgData = canvas.toDataURL('image/jpeg', 0.94)
      if (i > 0) pdf.addPage()
      pdf.addImage(imgData, 'JPEG', 0, 0, pageWidthMm, pageHeightMm)
    }
  } finally {
    cleanup()
  }

  return pdf.output('blob')
}
