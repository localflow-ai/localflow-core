import type { DocumentFormat } from './Proxy'

/**
 * Detect a document buffer's format from its magic bytes.
 * - `%PDF` → 'pdf'
 * - `PK\x03\x04` (zip container) → 'xlsx' — within the supported set, a zip is
 *   an Excel workbook. When more zip-based formats (docx, pptx…) are added,
 *   disambiguate by reading `[Content_Types].xml` inside the archive.
 * Returns null when the buffer matches no supported format.
 */
export function detectDocumentFormat(buffer: ArrayBuffer): DocumentFormat | null {
  const b = new Uint8Array(buffer.slice(0, 4))
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'pdf' // %PDF
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'xlsx' // PK..
  return null
}
