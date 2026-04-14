import html2canvas from 'html2canvas'
import { jsPDF } from 'jspdf'

/**
 * Render the cover letter editor element to an A4 PDF.
 * Same approach as resumePdf — rasterize the DOM with html2canvas, insert into jsPDF.
 * Cover letters are typically one page, so no pagination needed.
 */
export async function buildCoverLetterPdfFromElement(element: HTMLElement): Promise<Blob> {
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
  const pageWidthMm = pdf.internal.pageSize.getWidth()
  const pageHeightMm = pdf.internal.pageSize.getHeight()

  const canvas = await html2canvas(element, {
    scale: 2,
    useCORS: true,
    allowTaint: false,
    logging: false,
    backgroundColor: '#ffffff',
    windowWidth: element.scrollWidth,
    windowHeight: element.scrollHeight,
  })

  const imgData = canvas.toDataURL('image/jpeg', 0.94)
  pdf.addImage(imgData, 'JPEG', 0, 0, pageWidthMm, pageHeightMm)

  return pdf.output('blob')
}
