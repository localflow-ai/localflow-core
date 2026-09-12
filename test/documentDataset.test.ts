import { describe, it, expect } from 'vitest'
import { detectDocumentFormat } from '../src/documentFormat'
import { LocalAssistant } from '../src/LocalAssistant'
import { LocalProxy } from '../src/LocalProxy'

function buf(bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer
}

const PDF_BUF = buf([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])   // %PDF-1
const XLSX_BUF = buf([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])  // PK\x03\x04
const TXT_BUF = buf([0x68, 0x65, 0x6c, 0x6c, 0x6f])          // hello

describe('detectDocumentFormat', () => {
  it('detects PDF by %PDF magic bytes', () => {
    expect(detectDocumentFormat(PDF_BUF)).toBe('pdf')
  })
  it('detects xlsx by zip magic bytes', () => {
    expect(detectDocumentFormat(XLSX_BUF)).toBe('xlsx')
  })
  it('returns null for unknown formats and short buffers', () => {
    expect(detectDocumentFormat(TXT_BUF)).toBe(null)
    expect(detectDocumentFormat(buf([]))).toBe(null)
    expect(detectDocumentFormat(buf([0x25]))).toBe(null)
  })
})

describe('document datasets', () => {
  function makeAssistant(): LocalAssistant {
    return new LocalAssistant({ proxy: new LocalProxy() })
  }

  it('addDocumentDataset stores buffer, text, pageCount and metadata', () => {
    const a = makeAssistant()
    a.addDocumentDataset('book.xlsx', XLSX_BUF, 'sheet text', 2, { format: 'xlsx', pageNames: ['Q1', 'Q2'] })
    expect(a.getActiveDataset()).toMatchObject({ name: 'book.xlsx', type: 'document' })
    expect(a.getActiveDocumentBuffer()).toBe(XLSX_BUF)
    expect(a.getActiveDocumentExtractedText()).toBe('sheet text')
    expect(a.getActiveDocumentPageCount()).toBe(2)
    expect(a.getActiveDocumentMetadata()).toEqual({ format: 'xlsx', pageNames: ['Q1', 'Q2'] })
  })

  it('addPdfDataset (deprecated) delegates and keeps reporting type "pdf"', () => {
    const a = makeAssistant()
    a.addPdfDataset('report.pdf', PDF_BUF, 'pdf text', 3)
    expect(a.getActiveDataset()).toMatchObject({ name: 'report.pdf', type: 'pdf' })
    expect(a.getActiveDocumentMetadata()).toEqual({ format: 'pdf' })
    // deprecated getters still work
    expect(a.getActivePdfBuffer()).toBe(PDF_BUF)
    expect(a.getActivePdfExtractedText()).toBe('pdf text')
    expect(a.getActivePdfPageCount()).toBe(3)
  })

  it('tabular datasets are unaffected and document getters return empties for them', () => {
    const a = makeAssistant()
    a.addDataset('rows', [{ x: 1 }])
    expect(a.getActiveDataset()).toMatchObject({ name: 'rows', type: 'table', columns: ['x'] })
    expect(a.getActiveDocumentBuffer()).toBe(null)
    expect(a.getActiveDocumentExtractedText()).toBe('')
    expect(a.getActiveDocumentPageCount()).toBe(0)
    expect(a.getActiveDocumentMetadata()).toBe(null)
  })

  it('buildSandboxDocument works for a document dataset (buffer round-trip mode)', () => {
    const a = makeAssistant()
    a.addDocumentDataset('book.xlsx', XLSX_BUF, 'A | B', 1, { format: 'xlsx' })
    const doc = a.buildSandboxDocument('return { html: "", data: {}, reset: () => {} }')
    // document mode: sandbox waits for the buffer instead of running immediately
    expect(doc).toContain("parent.postMessage({ t: 'ready' }")
    expect(doc).toContain('documentData')
  })
})

describe('LocalProxy.extractDocument', () => {
  it('throws a format-aware standalone error without an xlsxModule', async () => {
    const p = new LocalProxy()
    await expect(p.extractDocument(XLSX_BUF)).rejects.toThrow(/xlsxModule/)
    await expect(p.extractDocument(TXT_BUF)).rejects.toThrow(/unknown format/)
  })
})

describe('local xlsx extraction (injected SheetJS module)', async () => {
  // The same module a host app passes in (`import * as XLSX from 'xlsx'`)
  const XLSX = await import('xlsx')

  function workbookBuffer(): ArrayBuffer {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Region', 'Amount', 'Date'],
      ['North', 1200.5, new Date(2026, 0, 15)],
      ['South', 800, null],
    ]), 'Sales')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Free text note, not a table'],
    ]), 'Notes')
    const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx', cellDates: true }) as ArrayBuffer
    return out
  }

  it('extracts sheets as pipe-row pages with names, fully locally', async () => {
    const p = new LocalProxy({ xlsxModule: XLSX })
    const res = await p.extractDocument(workbookBuffer())
    expect(res.pageCount).toBe(2)
    expect(res.documentMetadata).toEqual({ format: 'xlsx', pageNames: ['Sales', 'Notes'] })
    expect(res.text).toContain('## Page 1 — "Sales"')
    expect(res.text).toContain('Region | Amount | Date')
    // raw:false → cells render in their Excel display format (default date: m/d/yy)
    expect(res.text).toContain('North | 1200.5 | 1/15/26')
    expect(res.text).toContain('## Page 2 — "Notes"')
  })

  it('search matches sheet names and cell content (±1 context page)', async () => {
    const p = new LocalProxy({ xlsxModule: XLSX })
    const byName = await p.extractDocument(workbookBuffer(), 'Notes')
    expect(byName.text).toContain('"Notes"')
    const byCell = await p.extractDocument(workbookBuffer(), 'South')
    expect(byCell.text).toContain('"Sales"')
    const noHit = await p.extractDocument(workbookBuffer(), 'zzz-not-there')
    expect(noHit.text).toMatch(/No matches/)
  })

  it('ProxyClient with xlsxModule extracts locally — no network call', async () => {
    const { ProxyClient } = await import('../src/ProxyClient')
    const client = new ProxyClient('http://proxy.invalid', null, { xlsxModule: XLSX })
    // no token, unreachable host: only a local path can succeed
    const res = await client.extractDocument(workbookBuffer())
    expect(res.pageCount).toBe(2)
    expect(res.documentMetadata?.format).toBe('xlsx')
  })

  it('rejects a module that does not look like SheetJS', async () => {
    const p = new LocalProxy({ xlsxModule: { not: 'sheetjs' } })
    await expect(p.extractDocument(workbookBuffer())).rejects.toThrow(/SheetJS/)
  })
})
