import type { DocumentExtraction } from './Proxy'

/**
 * Local (in-browser) Excel extraction over an injected SheetJS module.
 *
 * Core deliberately has no runtime dependency on SheetJS: host apps already
 * bundle `xlsx` for their own file loading, so they pass their module in
 * (`xlsxModule` option on ProxyClient / LocalProxy) and the workbook never
 * leaves the device. The output mirrors the proxy's extract_xlsx.py — same
 * pipe-separated rows, same "## Page N" headers, same search semantics — so
 * formulas and prompts behave identically whichever path extracted the text.
 */

/** The minimal SheetJS surface we rely on (structural — any compatible build works). */
export interface XlsxModuleLike {
  read(data: ArrayBuffer | Uint8Array, opts?: Record<string, unknown>): {
    SheetNames: string[]
    Sheets: Record<string, unknown>
  }
  utils: {
    sheet_to_json(ws: unknown, opts?: Record<string, unknown>): unknown[]
    decode_range?(ref: string): { s: { r: number; c: number }; e: { r: number; c: number } }
  }
}

/** Same bound as the server-side extractor — a million-row sheet must not explode the prompt. */
const MAX_ROWS_PER_SHEET = 5000

function isXlsxModule(m: unknown): m is XlsxModuleLike {
  const x = m as XlsxModuleLike | null
  return !!x && typeof x.read === 'function' && typeof x.utils?.sheet_to_json === 'function'
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) {
    // Date-typed cells come back as midnight datetimes — render the date alone.
    const iso = `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
    if (v.getHours() === 0 && v.getMinutes() === 0 && v.getSeconds() === 0) return iso
    return `${iso} ${String(v.getHours()).padStart(2, '0')}:${String(v.getMinutes()).padStart(2, '0')}:${String(v.getSeconds()).padStart(2, '0')}`
  }
  // One cell must stay one column of one line: newlines inside a cell would
  // split the row, and a literal '|' would shift every column after it.
  // ▲/▼ are conditional-formatting glyphs (noise for the model and parsers).
  return String(v).replace(/[\r\n]+/g, ' ').replace(/\|/g, ' ').replace(/[▲▼]/g, '').replace(/\s+/g, ' ').trim()
}

/** Accent-insensitive, case-insensitive haystack — mirrors the proxy's fuzzy normalization. */
function normalize(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

export function extractXlsxLocally(xlsxModule: unknown, buffer: ArrayBuffer, searchString?: string): DocumentExtraction {
  if (!isXlsxModule(xlsxModule)) {
    throw new Error('xlsxModule does not look like a SheetJS module (needs read() and utils.sheet_to_json())')
  }
  const wb = xlsxModule.read(new Uint8Array(buffer), { type: 'array', cellDates: true })
  const pageNames = wb.SheetNames
  const pages = pageNames.map((name, i) => {
    const ws = wb.Sheets[name] as Record<string, unknown>
    // raw:false → the *displayed* strings (number formats, currency, %, dates),
    // so the text reads like the document the user sees in Excel.
    const rows = xlsxModule.utils.sheet_to_json(ws, { header: 1, raw: false, defval: null }) as unknown[][]

    // Merged regions: exports often duplicate the value into every covered cell
    // (and real merges only fill the anchor). Blank everything but the anchor so
    // a banner spanning 9 columns appears once, not 9 times.
    const merges = (ws['!merges'] ?? []) as { s: { r: number; c: number }; e: { r: number; c: number } }[]
    const origin = xlsxModule.utils.decode_range && typeof ws['!ref'] === 'string'
      ? xlsxModule.utils.decode_range(ws['!ref'] as string).s
      : { r: 0, c: 0 }
    for (const m of merges) {
      for (let r = m.s.r; r <= m.e.r; r++) {
        for (let c = m.s.c; c <= m.e.c; c++) {
          if (r === m.s.r && c === m.s.c) continue
          const row = rows[r - origin.r]
          if (row && c - origin.c < row.length) row[c - origin.c] = null
        }
      }
    }

    const lines: string[] = []
    let truncated = false
    for (let r = 0; r < rows.length; r++) {
      if (r >= MAX_ROWS_PER_SHEET) { truncated = true; break }
      const cells = (rows[r] ?? []).map(cellText)
      while (cells.length && cells[cells.length - 1] === '') cells.pop()
      if (!cells.length) continue
      lines.push(cells.join(' | '))
    }
    if (truncated) lines.push(`[... sheet truncated after ${MAX_ROWS_PER_SHEET} rows ...]`)
    return { label: name, text: lines.join('\n'), pageNum: i + 1 }
  })

  // Search + pagination, mirroring the proxy's formatPagesWithSearch(): matching
  // pages ±1 context page, gaps marked, sheet names searchable alongside content.
  const header = (i: number) => `## Page ${i + 1} — "${pages[i].label}"`
  const searchTerms = (searchString ?? '')
    .split(',')
    .map(t => normalize(t.trim()))
    .filter(t => t.length > 0)

  let finalContent = ''
  if (searchTerms.length > 0) {
    const normalized = pages.map(p => normalize(`${p.label}\n${p.text}`))
    const matched = new Set<number>()
    normalized.forEach((n, i) => {
      if (searchTerms.some(t => n.includes(t))) {
        if (i > 0) matched.add(i - 1)
        matched.add(i)
        if (i < pages.length - 1) matched.add(i + 1)
      }
    })
    const sorted = [...matched].sort((a, b) => a - b)
    let lastIdx = -1
    for (const idx of sorted) {
      if (lastIdx !== -1 && idx !== lastIdx + 1) {
        finalContent += `\n\n---\n[Omitted Content: Pages ${lastIdx + 2} to ${idx}]\n---\n\n`
      }
      finalContent += `${header(idx)}\n\n${pages[idx].text}\n\n`
      lastIdx = idx
    }
  } else {
    finalContent = pages.map((p, i) => `${header(i)}\n\n${p.text}`).join('\n\n')
  }

  return {
    text: finalContent.trim() || 'No matches found for the given search criteria.',
    pageCount: pageNames.length,
    documentMetadata: { format: 'xlsx', pageNames },
  }
}
