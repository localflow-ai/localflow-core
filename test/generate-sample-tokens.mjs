// Regenerates test/fixtures/sample-number-tokens.json — the distinct
// number-shaped column tokens found across the private pdf-samples. Run when the
// samples change:  node test/generate-sample-tokens.mjs
//
// Requires the sibling localflow-proxy checkout (its pdf-samples/ and the
// pdfplumber extractor). The fixture is git-ignored; the sample-driven test in
// sandboxHelpers.test.ts skips when it is absent.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const proxy = join(here, '..', '..', 'localflow-proxy')
const samplesDir = join(proxy, 'pdf-samples')
const script = join(proxy, 'scripts', 'extract_pdf.py')

if (!existsSync(samplesDir) || !existsSync(script)) {
  console.error('localflow-proxy pdf-samples / extractor not found at', proxy)
  process.exit(1)
}

const splitCols = (s) => String(s ?? '').split('|').map((c) => c.trim())

// A "value token" is a numeric cell parseNum is expected to handle: optional
// sign, digits with thousands separators (space/apostrophe) and a decimal comma
// or dot, plus an optional trailing unit. Excludes dates, descriptions, and
// long unbroken digit runs (account/reference numbers).
function isValueToken(t) {
  if (!t || t.indexOf('/') !== -1) return false
  const core = t.replace(/\s*[A-Za-z]{1,4}\.?\s*$/, '').trim()
  if (/[A-Za-z]/.test(core)) return false
  const norm = core.replace(/[\s']/g, '').replace(/,/g, '.')
  if (!/^-?\d*\.?\d+$/.test(norm)) return false
  if (norm.replace('-', '').split('.')[0].length >= 10) return false
  return /\d/.test(norm)
}

const tokens = new Set()
for (const f of readdirSync(samplesDir).filter((f) => f.endsWith('.pdf'))) {
  const out = execFileSync('python3', [script], {
    input: readFileSync(join(samplesDir, f)),
    maxBuffer: 64 * 1024 * 1024,
  })
  const json = JSON.parse(out.toString())
  for (const page of json.pages)
    for (const line of String(page.text).split('\n'))
      for (const cell of splitCols(line)) if (isValueToken(cell)) tokens.add(cell)
}

const list = [...tokens].sort()
mkdirSync(join(here, 'fixtures'), { recursive: true })
writeFileSync(join(here, 'fixtures', 'sample-number-tokens.json'), JSON.stringify(list, null, 2) + '\n')
console.log(`wrote ${list.length} distinct value tokens from pdf-samples`)

// ---------------------------------------------------------------------------
// Excel samples — two fixtures per concern (requires `npm run build` first,
// the generator imports dist/xlsxLocal.js which has no runtime deps):
//
// 1. xlsx-cell-pairs.json — every numeric cell's DISPLAY string next to its
//    RAW value, the ground-truth oracle for the parsers: whatever locale the
//    workbook renders in, parseMoney/parseNum(display) must recover the raw
//    magnitude (percent cells: raw x 100 — "%" formats store fractions).
// 2. xlsx-local-baselines/<name>.txt — full extractXlsxLocally output, the
//    local-extraction analog of the proxy's PDF baselines.
// ---------------------------------------------------------------------------
const XLSX = await import('xlsx')
const { extractXlsxLocally } = await import('../dist/xlsxLocal.js')

const pairs = []
const xlsxFiles = readdirSync(samplesDir).filter((f) => f.endsWith('.xlsx'))
mkdirSync(join(here, 'fixtures', 'xlsx-local-baselines'), { recursive: true })
for (const f of xlsxFiles) {
  const buf = readFileSync(join(samplesDir, f))
  const wb = XLSX.read(buf, { type: 'buffer' })
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name]
    for (const addr of Object.keys(ws)) {
      if (addr.charAt(0) === '!') continue
      const cell = ws[addr]
      // numeric cells with a rendered string; skip dates/times (not parser targets)
      if (cell.t !== 'n' || typeof cell.w !== 'string' || /[/:]/.test(cell.w)) continue
      // Same sanitation extractXlsxLocally applies — pairs must mirror what
      // formulas actually receive (▲/▼ glyphs stripped, whitespace collapsed).
      const text = cell.w.replace(/[\r\n]+/g, ' ').replace(/\|/g, ' ').replace(/[▲▼]/g, '').replace(/\s+/g, ' ').trim()
      if (!/\d/.test(text)) continue
      pairs.push({ text, value: cell.v })
    }
  }
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  writeFileSync(join(here, 'fixtures', 'xlsx-local-baselines', f + '.txt'), extractXlsxLocally(XLSX, ab).text + '\n')
}
writeFileSync(join(here, 'fixtures', 'xlsx-cell-pairs.json'), JSON.stringify(pairs, null, 2) + '\n')
console.log(`wrote ${pairs.length} display/raw cell pairs and ${xlsxFiles.length} local-extraction baseline(s) from xlsx samples`)
