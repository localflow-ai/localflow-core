// Benchmark tasks. Each task is a (possibly multi-turn) prompt plus a mechanical
// `check` that inspects the executed result. All "golden" numbers are computed
// FROM the CSV at runtime — nothing is hardcoded — so the checks stay correct if
// the dataset is swapped.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { AssistantResponse } from '../src/types'
import type { ExecuteResult } from './execute'

const __dirname = dirname(fileURLToPath(import.meta.url))

export type Row = Record<string, string>

/** One executed turn: the model response and what running its formula produced. */
export interface RunStep {
  res: AssistantResponse
  exec: ExecuteResult
}

/** Context handed to a checker: the loaded rows so checks can derive golden values. */
export interface TaskContext {
  rows: Row[]
}

export interface Task {
  id: string
  /** Column header in benchmarks.md this task scores. */
  column: string
  /** One entry per conversation turn (multi-turn supported). */
  turns: string[]
  check: (runs: RunStep[], ctx: TaskContext) => boolean
}

// ---------------------------------------------------------------------------
// CSV loading
// ---------------------------------------------------------------------------

/**
 * Hand-rolled CSV parse — no parser dependency. Splits on newlines, handles
 * minimally-quoted fields (double quotes, "" escape). Numeric cells are kept as
 * STRINGS, exactly as a real CSV import into LocalFlow would (the sandbox's
 * parseNum/parseMoney do the conversion later).
 */
function parseCsv(text: string): Row[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.length > 0)
  if (lines.length === 0) return []
  const headers = splitCsvLine(lines[0])
  const rows: Row[] = []
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i])
    const row: Row = {}
    headers.forEach((h, j) => {
      row[h] = cells[j] ?? ''
    })
    rows.push(row)
  }
  return rows
}

/** Split a single CSV line, honouring double-quoted fields with "" escapes. */
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cur += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      out.push(cur)
      cur = ''
    } else {
      cur += c
    }
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

/** Load bench/datasets/disasters.csv as rows of string cells. */
export function loadDataset(): Row[] {
  const path = join(__dirname, 'datasets', 'disasters.csv')
  return parseCsv(readFileSync(path, 'utf8'))
}

// ---------------------------------------------------------------------------
// Golden-value helpers (derived from the CSV at runtime)
// ---------------------------------------------------------------------------

const DEATHS_COL = 'Deaths'
const ENTITY_COL = 'Entity'

function num(s: unknown): number {
  const v = parseFloat(String(s ?? '').replace(/[\s']/g, '').replace(/,/g, '.'))
  return Number.isFinite(v) ? v : 0
}

/** Total Deaths over every row. */
function totalDeaths(rows: Row[]): number {
  return rows.reduce((s, r) => s + num(r[DEATHS_COL]), 0)
}

/** Max single-row Deaths value (for the regression blow-up bound). */
function maxDeaths(rows: Row[]): number {
  return rows.reduce((m, r) => Math.max(m, num(r[DEATHS_COL])), 0)
}

/** Per-entity Deaths totals → the set of plausible "single entity" sums. */
function perEntityTotals(rows: Row[]): number[] {
  const by: Record<string, number> = {}
  for (const r of rows) {
    const e = r[ENTITY_COL] ?? '(none)'
    by[e] = (by[e] ?? 0) + num(r[DEATHS_COL])
  }
  return Object.values(by)
}

/** Every numeric array nested anywhere inside an arbitrary value. */
function numericArrays(value: unknown, acc: number[][] = [], depth = 0): number[][] {
  if (depth > 8 || value == null) return acc
  if (Array.isArray(value)) {
    // Flat array of numbers (or numeric strings) → a candidate series.
    const nums = value.map((x) => (typeof x === 'number' ? x : Number(x))).filter((x) => Number.isFinite(x))
    if (nums.length > 0 && nums.length === value.length) acc.push(nums)
    // Array of [a, b, …] pairs (ECharts [category, value] / [x, y]) → EACH column
    // as its own series, so a [year, deaths] shape surfaces the deaths column too
    // (not just the first finite, which would be the year).
    const pairs = value.filter((x) => Array.isArray(x) && (x as unknown[]).length >= 2) as unknown[][]
    if (pairs.length > 0 && pairs.length === value.length) {
      for (const col of [0, 1]) {
        const colVals = pairs.map((p) => Number(p[col])).filter((v) => Number.isFinite(v))
        if (colVals.length === pairs.length) acc.push(colVals)
      }
    }
    // Array of homogeneous objects (records like {year, deaths}, or ECharts
    // {value:n}) → each numeric field as its own series.
    const objs = value.filter((x) => x != null && typeof x === 'object' && !Array.isArray(x)) as Record<string, unknown>[]
    if (objs.length > 0 && objs.length === value.length) {
      const keys = new Set<string>()
      for (const o of objs) for (const k of Object.keys(o)) keys.add(k)
      for (const k of keys) {
        const colVals = objs.map((o) => Number(o[k])).filter((v) => Number.isFinite(v))
        if (colVals.length === objs.length) acc.push(colVals)
      }
    }
    for (const item of value) numericArrays(item, acc, depth + 1)
  } else if (typeof value === 'object') {
    const vals = Object.values(value as Record<string, unknown>)
    // A {key: number} map — e.g. deaths-by-year { '1900': 1267360, … } — is a series
    // too: models frequently return the aggregate as a map rather than an array.
    const nums = vals.map((v) => (typeof v === 'number' ? v : Number(v))).filter((v) => Number.isFinite(v))
    if (nums.length > 1 && nums.length === vals.length) acc.push(nums)
    for (const v of vals) numericArrays(v, acc, depth + 1)
  }
  return acc
}

/** All flat numeric arrays found in the executed data AND any captured chart options. */
function allSeries(exec: ExecuteResult): number[][] {
  return [...numericArrays(exec.data), ...numericArrays(exec.echartsOptions)]
}

function approxEq(a: number, b: number, tolFrac: number): boolean {
  if (b === 0) return a === 0
  return Math.abs(a - b) / Math.abs(b) <= tolFrac
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const tasks: Task[] = [
  {
    id: 'aggregate-by-year',
    column: 'Aggregate',
    turns: ["Montre l'évolution du nombre de morts par année (somme par année)."],
    check: (runs, ctx) => {
      const { exec } = runs[runs.length - 1]
      if (!exec.ok) return false
      if (exec.data == null) return false
      // Defensible golden totals, any of which a correct answer might hit:
      //  • grand total over all rows (double-counts if an "All …" aggregate row exists);
      //  • each single-entity total (model filtered to one entity);
      //  • all rows MINUS one entity (model excluded the aggregate to avoid double
      //    counting — the analytically-correct move on this dataset).
      const total = totalDeaths(ctx.rows)
      const perEntity = perEntityTotals(ctx.rows)
      const candidates = [total, ...perEntity, ...perEntity.map((e) => total - e)]
      const series = allSeries(exec)
      return series.some((s) => {
        const sum = s.reduce((a, b) => a + b, 0)
        return candidates.some((c) => approxEq(sum, c, 0.005))
      })
    },
  },
  {
    id: 'regression',
    column: 'Regression',
    turns: [
      "Montre l'évolution du nombre de morts par année et ajoute une courbe de tendance polynomiale (régression).",
    ],
    check: (runs, ctx) => {
      const { exec } = runs[runs.length - 1]
      if (!exec.ok) return false
      const series = allSeries(exec)
      // Need at least two distinct series (data + a fit/trend line), OR a single
      // series plus a fit array surfaced in data under a trend-ish key.
      const hasTwoSeries = series.length >= 2
      const dataObj = exec.data && typeof exec.data === 'object' ? (exec.data as Record<string, unknown>) : {}
      const trendKey = Object.keys(dataObj).find((k) => /fit|trend|reg|poly/i.test(k))
      const hasTrendArray = !!trendKey && Array.isArray(dataObj[trendKey])
      if (!hasTwoSeries && !hasTrendArray) return false
      // The fabricated-coefficient failure blows trend values up to ~1e15. Bound
      // every series value by MAGNITUDE to 5×maxDeaths and require all finite —
      // a legitimate polynomial fit can dip slightly negative where the curve
      // crosses zero, so we bound |v|, not v itself; the 1e15 blow-up is still
      // far outside the bound. When a fit/trend array is present we check it
      // specifically; otherwise we check every produced series.
      const bound = 5 * maxDeaths(ctx.rows)
      const candidate = hasTrendArray
        ? [(dataObj[trendKey!] as unknown[]).map((x) => Number(x))]
        : series
      return candidate.every((s) => s.every((v) => Number.isFinite(v) && Math.abs(v) <= bound))
    },
  },
  {
    id: 'refinement',
    column: 'Refinement',
    turns: [
      "Montre l'évolution du nombre de morts par année (somme par année).",
      'Ajoute une légende.',
    ],
    check: (runs) => {
      // Only the SECOND turn matters: a follow-up that re-emits a complete,
      // runnable snippet returning { html, data }. The classic failure is a
      // fragment (`option = {…}` / undefined vars) that throws or returns no html.
      const second = runs[1]
      if (!second || !second.exec.ok) return false
      return typeof second.exec.html === 'string' && second.exec.html.length > 0 && second.exec.data != null
    },
  },
]
