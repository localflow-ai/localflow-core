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
