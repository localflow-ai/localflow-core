import type { DocumentFormat } from './Proxy'

/** True if the ASCII needle occurs in the buffer (used to peek at zip entry names). */
function bytesInclude(bytes: Uint8Array, ascii: string): boolean {
  const needle = ascii.split('').map(ch => ch.charCodeAt(0))
  const last = bytes.length - needle.length
  outer: for (let i = 0; i <= last; i++) {
    if (bytes[i] !== needle[0]) continue
    for (let j = 1; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) continue outer
    }
    return true
  }
  return false
}

/**
 * Detect a document buffer's format from its magic bytes.
 * - `%PDF` → 'pdf'
 * - `PK\x03\x04` (zip container) → peek at the entry names, which zip stores
 *   uncompressed: `xl/workbook.xml` → 'xlsx', `word/document.xml` → 'docx'.
 *   Other zip-based formats (pptx, odt…) return null.
 * Returns null when the buffer matches no supported format.
 */
export function detectDocumentFormat(buffer: ArrayBuffer): DocumentFormat | null {
  const bytes = new Uint8Array(buffer)
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf' // %PDF
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) { // PK..
    if (bytesInclude(bytes, 'xl/workbook.xml')) return 'xlsx'
    if (bytesInclude(bytes, 'word/document.xml')) return 'docx'
  }
  return null
}
