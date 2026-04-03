import html2canvas from 'html2canvas'
import { jsPDF } from 'jspdf'

/**
 * Rasterize a DOM node (the same resume preview the user edits) into a multi-page A4 PDF.
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

  const imgData = canvas.toDataURL('image/jpeg', 0.92)
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
  const pageWidth = pdf.internal.pageSize.getWidth()
  const pageHeight = pdf.internal.pageSize.getHeight()

  const imgWidthMm = pageWidth
  const imgHeightMm = (canvas.height * imgWidthMm) / canvas.width

  let heightLeft = imgHeightMm
  let y = 0

  pdf.addImage(imgData, 'JPEG', 0, y, imgWidthMm, imgHeightMm)
  heightLeft -= pageHeight

  while (heightLeft > 0.5) {
    y = heightLeft - imgHeightMm
    pdf.addPage()
    pdf.addImage(imgData, 'JPEG', 0, y, imgWidthMm, imgHeightMm)
    heightLeft -= pageHeight
  }

  return pdf.output('blob')
}
