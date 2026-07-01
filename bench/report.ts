// Reads every bench/results/*.json and regenerates the two capability tables in
// benchmarks.md, replacing only the content between the marker pairs.
//
// Split by DEPLOYMENT:
//   - Frontier (hosted) — one row per model; the machine is irrelevant for an API.
//   - Local (Ollama)    — one row per (model × Hardware × OS); local scores AND
//                         speed are hardware-dependent, so the same model on a GPU
//                         box vs a CPU-only server are different rows.
// Both share the capability COLUMNS (Aggregate / Regression / Refinement) so they
// are directly comparable, plus a median-latency column. Each cell is
// `passes/runs`, or `—` when that row never ran that task.

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tasks } from './tasks'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RESULTS_DIR = join(__dirname, 'results')
const BENCH_MD = join(__dirname, '..', 'benchmarks.md')

const FRONTIER_START = '<!-- BENCH:TABLE:FRONTIER:START -->'
const FRONTIER_END = '<!-- BENCH:TABLE:FRONTIER:END -->'
const LOCAL_START = '<!-- BENCH:TABLE:LOCAL:START -->'
const LOCAL_END = '<!-- BENCH:TABLE:LOCAL:END -->'

interface Host {
  cpu: string
  cores?: number
  arch?: string
  ramGB: number
  platform?: string
  osRelease?: string
  gpu?: string
}

interface ResultFile {
  provider: string
  model: string
  size: string
  deployment?: 'hosted' | 'local'
  thinking?: string | null
  host?: Host
  /** Legacy: pre-`host` results carried only `{ ramGB, cpu }`. */
  hardware?: { ramGB: number; cpu: string }
  date: string
  runs: number
  latencyMsMedian?: number
  tasks: Record<string, { passes: number; runs: number }>
}

interface Row {
  model: string
  thinking: string
  hardware: string
  os: string
  ramGB: number
  runs: number
  date: string
  latencyMsMedian?: number
  cells: Record<string, { passes: number; runs: number; date: string }>
}

/** Back-compat: infer deployment for older result files that predate the field. */
function deploymentOf(f: ResultFile): 'hosted' | 'local' {
  return f.deployment ?? (f.provider === 'openai' ? 'hosted' : 'local')
}

/** Hardware descriptor: "Apple M5 · 16 GB · Metal". */
function hardwareOf(f: ResultFile): string {
  if (f.host) return `${f.host.cpu} · ${f.host.ramGB} GB · ${f.host.gpu ?? 'unknown'}`
  if (f.hardware) return `${f.hardware.cpu} · ${f.hardware.ramGB} GB` // legacy
  return 'unknown'
}

/** Friendly OS family from the captured platform. */
function osOf(f: ResultFile): string {
  switch (f.host?.platform) {
    case 'darwin': return 'macOS'
    case 'linux': return 'Linux'
    case 'win32': return 'Windows'
    default: return f.host?.platform ?? 'unknown'
  }
}

function ramOf(f: ResultFile): number {
  return f.host?.ramGB ?? f.hardware?.ramGB ?? 0
}

/** Thinking level (reasoning_effort) used, or "default" when unset. */
function thinkingOf(f: ResultFile): string {
  return f.thinking ?? 'default'
}

function loadResults(): ResultFile[] {
  if (!existsSync(RESULTS_DIR)) return []
  return readdirSync(RESULTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(RESULTS_DIR, f), 'utf8')) as ResultFile
      } catch {
        return null
      }
    })
    .filter((r): r is ResultFile => r != null)
}

/** Aggregate into rows; within a cell the newest run wins. `perMachine` groups
 *  local rows by (model × Hardware × OS); hosted rows group by model only. */
function aggregate(files: ResultFile[], perMachine: boolean): Row[] {
  const byKey = new Map<string, Row>()
  for (const f of files) {
    const hardware = hardwareOf(f)
    const os = osOf(f)
    const thinking = thinkingOf(f)
    // Both tables distinguish rows by thinking level (low vs high/default are
    // different data points); local rows are ALSO keyed by the machine they ran on.
    const key = perMachine ? `${f.model}@@${hardware}@@${os}@@${thinking}` : `${f.model}@@${thinking}`
    let row = byKey.get(key)
    if (!row) {
      row = { model: f.model, thinking, hardware, os, ramGB: ramOf(f), runs: f.runs, date: f.date, latencyMsMedian: f.latencyMsMedian, cells: {} }
      byKey.set(key, row)
    }
    if (f.date >= row.date) {
      row.date = f.date
      row.runs = f.runs
      if (f.latencyMsMedian != null) row.latencyMsMedian = f.latencyMsMedian
    }
    for (const [taskId, score] of Object.entries(f.tasks)) {
      const ex = row.cells[taskId]
      if (!ex || f.date > ex.date) row.cells[taskId] = { passes: score.passes, runs: score.runs, date: f.date }
    }
  }
  return [...byKey.values()].sort(
    (a, b) => a.model.localeCompare(b.model) || a.ramGB - b.ramGB || a.hardware.localeCompare(b.hardware),
  )
}

function fmtLatency(ms?: number): string {
  if (ms == null) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`
}

/** Pass rate as a whole-number percent, or `—` when the task wasn't run. */
function pct(cell?: { passes: number; runs: number }): string {
  if (!cell || cell.runs <= 0) return '—'
  return `${Math.round((cell.passes / cell.runs) * 100)}%`
}

function buildTable(rows: Row[], kind: 'hosted' | 'local'): string {
  const cols = tasks.map((t) => t.column)
  const idCols = kind === 'local' ? ['Model', 'Hardware', 'OS', 'Thinking'] : ['Model', 'Thinking']
  const headCells = [...idCols, 'Runs', ...cols, 'Latency']
  const header = `| ${headCells.join(' | ')} |`
  const sep = `| ${headCells.map(() => '---').join(' | ')} |`
  if (rows.length === 0) {
    const note = kind === 'local'
      ? '_no results yet — run `npm run bench -- --provider ollama --model <id>`_'
      : '_no baseline yet — run `npm run bench -- --provider openai --base-url <router> --model <id>`_'
    const blanks = [...idCols.slice(1).map(() => '—'), '—', ...cols.map(() => '—'), '—']
    return [header, sep, `| ${[note, ...blanks].join(' | ')} |`].join('\n')
  }
  const body = rows.map((row) => {
    const id = kind === 'local' ? [row.model, row.hardware, row.os, row.thinking] : [row.model, row.thinking]
    const caps = tasks.map((t) => pct(row.cells[t.id]))
    return `| ${[...id, String(row.runs), ...caps, fmtLatency(row.latencyMsMedian)].join(' | ')} |`
  })
  return [header, sep, ...body].join('\n')
}

function replaceBlock(md: string, start: string, end: string, table: string): string {
  const s = md.indexOf(start)
  const e = md.indexOf(end)
  if (s === -1 || e === -1 || e < s) {
    throw new Error(`benchmarks.md: missing or malformed ${start} / ${end} markers`)
  }
  return md.slice(0, s + start.length) + `\n\n${table}\n\n` + md.slice(e)
}

function main() {
  const files = loadResults()
  const hosted = aggregate(files.filter((f) => deploymentOf(f) === 'hosted'), false)
  const local = aggregate(files.filter((f) => deploymentOf(f) === 'local'), true)

  let md = readFileSync(BENCH_MD, 'utf8')
  md = replaceBlock(md, FRONTIER_START, FRONTIER_END, buildTable(hosted, 'hosted'))
  md = replaceBlock(md, LOCAL_START, LOCAL_END, buildTable(local, 'local'))
  writeFileSync(BENCH_MD, md)

  console.log(
    `bench:report — ${files.length} result file(s): ` +
      `${hosted.length} frontier row(s), ${local.length} local row(s) → benchmarks.md`,
  )
}

main()
