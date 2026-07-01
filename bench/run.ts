// Benchmark CLI: run a model (local Ollama, a hosted provider, or the built-in
// mock) against the LocalFlow formula tasks N times each, score with
// mechanical/golden checks, and write a results JSON. No API key is needed for
// local/mock — the checks read the model's output, not a reference LLM. Hosted
// providers (openai/gemini/anthropic, or a router via --base-url) need a key,
// passed via env (BENCH_API_KEY / MIMO_API_KEY) — never written to the results.
//
//   npm run bench -- --provider mock
//   npm run bench -- --provider ollama --model qwen3:8b
//   BENCH_API_KEY=<YOUR_API_KEY> npm run bench -- --provider gemini --model gemini-2.5-flash
//   BENCH_API_KEY=<YOUR_API_KEY> npm run bench -- --provider openai --base-url <BASE_URL> --model <id>
//
// Flags:
//   --provider openai|gemini|anthropic|ollama|mock  (default: mock)
//   --model <id>                   model id (label component for mock)
//   --base-url <url>               override the provider's built-in base URL (e.g. a router)
//   --api-key <key>                hosted key (prefer env BENCH_API_KEY / MIMO_API_KEY)
//   --size small|large             LocalAssistant modelSize (default: large for hosted, else small)
//   --deployment hosted|local      which table the row lands in (default: from the provider)
//   --runs N                       runs per task (default: 3)
//   --gpu <label>                  override auto-detected accelerator (e.g. "RTX 4090", "CPU only")
//   --thinking low|medium|high     hosted: reasoning_effort. ollama: low⇒thinking OFF, medium/high⇒ON
//   --list-models                  print the provider's available model ids and exit
//   --debug                        on a failing run, print the model's formula + result

import os from 'node:os'
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { LocalAssistant } from '../src/index'
import type { LLMRequest } from '../src/Proxy'
import { MockProxy, OpenAICompatProxy, OllamaNativeProxy } from './proxies'
import { executeFormula } from './execute'
import { loadDataset, tasks } from './tasks'
import type { RunStep, Task } from './tasks'
import { GOOD_AGGREGATE, GOOD_REGRESSION, BAD_LEGEND_FRAGMENT } from './mockFormulas'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATASET_NAME = 'disasters.csv'

// Named providers with built-in OpenAI-compatible base URLs, so a key + model is
// enough (no --base-url). Override --base-url to point at a router/proxy (e.g. a
// MiMo/OpenRouter gateway serving several models). `ollama`/`mock` are local.
type ProviderName = 'openai' | 'gemini' | 'anthropic' | 'ollama' | 'mock'

interface ProviderDef {
  baseUrl?: string
  deployment: 'hosted' | 'local'
  needsKey: boolean
}

const PROVIDERS: Record<ProviderName, ProviderDef> = {
  openai:    { baseUrl: 'https://api.openai.com/v1',                               deployment: 'hosted', needsKey: true },
  gemini:    { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', deployment: 'hosted', needsKey: true },
  anthropic: { baseUrl: 'https://api.anthropic.com/v1',                            deployment: 'hosted', needsKey: true },
  ollama:    { baseUrl: 'http://localhost:11434/v1',                               deployment: 'local',  needsKey: false },
  mock:      { deployment: 'local', needsKey: false },
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface Args {
  provider: ProviderName
  model?: string
  baseUrl?: string // override; falls back to the provider's built-in base URL
  apiKey?: string
  size: 'small' | 'large'
  deployment: 'hosted' | 'local'
  runs: number
  gpu?: string
  thinking?: 'low' | 'medium' | 'high'
  listModels: boolean
  debug: boolean
}

function parseArgs(argv: string[]): Args {
  const raw: Record<string, string | undefined> = {}
  let listModels = false
  let debug = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const name = a.slice(2)
    if (name === 'list-models') { listModels = true; continue } // boolean flags — no value
    if (name === 'debug') { debug = true; continue }
    raw[name] = argv[i + 1]; i++
  }
  const provider: ProviderName =
    raw.provider && raw.provider in PROVIDERS ? (raw.provider as ProviderName) : 'mock'
  const def = PROVIDERS[provider]
  const size: Args['size'] =
    raw.size === 'large' ? 'large'
      : raw.size === 'small' ? 'small'
      : def.deployment === 'hosted' ? 'large' : 'small'
  const deployment: Args['deployment'] =
    raw.deployment === 'hosted' ? 'hosted'
      : raw.deployment === 'local' ? 'local'
      : def.deployment
  return {
    provider,
    model: raw.model,
    baseUrl: raw['base-url'],
    apiKey: raw['api-key'] ?? process.env.BENCH_API_KEY ?? process.env.MIMO_API_KEY,
    size,
    deployment,
    runs: Math.max(1, parseInt(raw.runs ?? '3', 10) || 3),
    gpu: raw.gpu,
    thinking: (['low', 'medium', 'high'] as const).find((t) => t === raw.thinking),
    listModels,
    debug,
  }
}

// ---------------------------------------------------------------------------
// Host detection (CPU / RAM / GPU) — so a local latency is interpretable
// ---------------------------------------------------------------------------

/** Trim marketing noise from an `os.cpus()` model string. */
function shortenCpu(s: string): string {
  return s
    .replace(/\((R|TM)\)/g, '')
    .replace(/\bCPU\b/g, '')
    .replace(/\bProcessor\b/g, '')
    .replace(/@.*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Best-effort accelerator detection — the single biggest factor in local
 * latency. Reports what Ollama would actually use (Metal / CUDA / ROCm) or
 * "CPU only", NOT any display adapter (a server's management VGA is irrelevant).
 * Falls back gracefully and can be overridden with `--gpu`.
 */
function detectGpu(override?: string): string {
  if (override) return override
  const tryCmd = (cmd: string): string | null => {
    try {
      return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 }).toString().trim() || null
    } catch {
      return null
    }
  }
  const platform = os.platform()
  if (platform === 'darwin') {
    if (os.arch() === 'arm64') return 'Apple Silicon (Metal)'
    const chip = tryCmd(`system_profiler SPDisplaysDataType 2>/dev/null | awk -F': ' '/Chipset Model/ {print $2; exit}'`)
    return chip ? `${chip} (Metal)` : 'CPU only'
  }
  if (platform === 'linux') {
    const nv = tryCmd('nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1')
    if (nv) return `NVIDIA ${nv.replace(/^NVIDIA\s+/i, '')}`
    const rocm = tryCmd(`rocminfo 2>/dev/null | awk -F': ' '/Marketing Name/ {print $2; exit}'`)
    if (rocm) return `AMD ${rocm.trim()}`
    return 'CPU only'
  }
  return 'unknown'
}

function detectHost(gpuOverride?: string) {
  const cpus = os.cpus()
  return {
    cpu: shortenCpu(cpus[0]?.model ?? 'unknown'),
    cores: cpus.length,
    arch: os.arch(),
    ramGB: Math.round(os.totalmem() / 2 ** 30),
    platform: os.platform(),
    osRelease: os.release(),
    gpu: detectGpu(gpuOverride),
  }
}

// ---------------------------------------------------------------------------
// Mock responder (size-aware: raw code for small, JSON envelope for large)
// ---------------------------------------------------------------------------

/**
 * Canned responder for `--provider mock`. Returns a GOOD aggregate/regression
 * formula for single-turn prompts, and — to exercise a realistic failure — a bare
 * `option = {…}` fragment for the legend follow-up. In `large` mode it wraps the
 * code in the JSON envelope a hosted model would emit, so the JSON-parse path is
 * exercised without a key.
 */
function mockResponder(size: 'small' | 'large') {
  return (req: LLMRequest): string => {
    const userMsgs = req.messages.filter((m) => m.role === 'user')
    const last = (userMsgs[userMsgs.length - 1]?.content ?? '').toLowerCase()
    const isFollowUp = req.messages.length > 1
    let formula: string
    if (isFollowUp && last.includes('légende')) formula = BAD_LEGEND_FRAGMENT
    else if (last.includes('tendance') || last.includes('régression') || last.includes('regression')) formula = GOOD_REGRESSION
    else formula = GOOD_AGGREGATE
    return size === 'large'
      ? JSON.stringify({ answer: 'Voici le résultat.', formula, title: 'Analyse' })
      : formula
  }
}

function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)
}

// ---------------------------------------------------------------------------
// Debug trace (always written to bench/debug/last-run.log, cleared each run)
// ---------------------------------------------------------------------------

function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}… (+${s.length - n} chars)` : s
}

function fmtData(d: unknown): string {
  if (d == null) return String(d)
  if (typeof d === 'string') return trunc(d, 2000)
  try { return trunc(JSON.stringify(d), 2000) } catch { return String(d) }
}

/** One run's full trace: each turn's prompt, generated formula (or raw text when
 *  it didn't parse), and what executing it produced. */
function formatRun(task: Task, runNo: number, totalRuns: number, steps: RunStep[], passed: boolean): string {
  const out: string[] = [`### ${task.id} — run ${runNo}/${totalRuns} — ${passed ? 'PASS' : 'FAIL'}`]
  task.turns.forEach((turn, i) => {
    const step = steps[i]
    out.push(`[turn ${i + 1}] prompt: ${turn}`)
    if (!step) { out.push('  (no result — run aborted before this turn)'); return }
    out.push(
      step.res.formula
        ? '  formula:\n' + step.res.formula.split('\n').map((l) => '    ' + l).join('\n')
        : '  formula: (empty — model output did not parse as the expected schema)',
    )
    if (!step.res.formula) {
      // Parse failure → `answer` holds the raw model text. Write it in FULL (this is
      // exactly what we need to inspect): a JSON cut off mid-string = truncation;
      // a cleanly-closed-but-invalid one = a malformed-output bug. The tail tells which.
      const rawText = step.res.answer ?? ''
      out.push(`  answer/raw (${rawText.length} chars, FULL):\n${rawText}`)
    }
    out.push(`  exec: ok=${step.exec.ok} error=${step.exec.error ?? '(none)'} htmlLen=${step.exec.html?.length ?? 0}`)
    out.push('  data: ' + fmtData(step.exec.data))
    // Also dump captured chart options — regression's trend series lives here, not
    // in `data`, so it's needed to tell an over-bound fit from a too-strict check.
    const opts = step.exec.echartsOptions
    if (Array.isArray(opts) && opts.length > 0) {
      let s: string
      try { s = JSON.stringify(opts) } catch { s = String(opts) }
      out.push('  echartsOptions: ' + trunc(s, 6000))
    }
  })
  return out.join('\n') + '\n\n'
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const rows = loadDataset()
  const datasets = { [DATASET_NAME]: rows }

  // Resolve the base URL (provider default unless overridden) and validate up front.
  const baseUrl = args.provider === 'mock' ? undefined : (args.baseUrl ?? PROVIDERS[args.provider].baseUrl)

  // `--list-models`: print the endpoint's model ids and exit — handy when a model
  // id 404s (provider naming varies). Handles OpenAI-compat (`data[].id`) and
  // Google-native (`models[].name`) response shapes.
  if (args.listModels) {
    if (!baseUrl) throw new Error('--list-models needs a hosted provider (or --base-url)')
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers: args.apiKey ? { Authorization: `Bearer ${args.apiKey}` } : {},
    })
    if (!res.ok) {
      throw new Error(`list-models: HTTP ${res.status} ${res.statusText}: ${(await res.text().catch(() => '')).slice(0, 300)}`)
    }
    const json = (await res.json()) as { data?: Array<{ id?: string }>; models?: Array<{ name?: string }> }
    const ids = [...(json.data ?? []).map((m) => m.id), ...(json.models ?? []).map((m) => m.name)].filter(Boolean)
    console.log(ids.length ? ids.join('\n') : '(no models returned)')
    return
  }

  if (args.provider !== 'mock') {
    if (!baseUrl) throw new Error(`provider "${args.provider}" needs --base-url`)
    if (!args.model) throw new Error(`provider "${args.provider}" needs --model`)
    if (PROVIDERS[args.provider].needsKey && !args.apiKey) {
      throw new Error('hosted provider needs a key: set BENCH_API_KEY (or MIMO_API_KEY / --api-key)')
    }
  }

  // Local Ollama uses its NATIVE /api/chat — the only path that can disable
  // thinking. Mapping the shared level onto Ollama's boolean `think`:
  // low ⇒ off, medium/high ⇒ on, unset ⇒ Ollama's default (on for qwen3).
  const makeProxy = () => {
    if (args.provider === 'mock') return MockProxy(mockResponder(args.size))
    if (args.provider === 'ollama') {
      const think = args.thinking === undefined ? undefined : args.thinking !== 'low'
      return OllamaNativeProxy({ baseUrl: baseUrl!, model: args.model!, think })
    }
    return OpenAICompatProxy({ baseUrl: baseUrl!, model: args.model!, apiKey: args.apiKey, reasoningEffort: args.thinking })
  }

  const modelLabel = args.model ?? (args.provider === 'mock' ? 'mock' : args.size)

  console.log(
    `bench: provider=${args.provider} model=${modelLabel} size=${args.size} ` +
      `deployment=${args.deployment} runs=${args.runs} tasks=${tasks.length} rows=${rows.length}` +
      (baseUrl ? ` base=${baseUrl}` : '') +
      (args.provider !== 'mock' ? ` thinking=${args.thinking ?? 'default'}` : ''),
  )

  const host = detectHost(args.gpu)

  // Always persist a full trace of THIS run (cleared each time) so a bad result is
  // inspectable afterwards without reproducing it. Gitignored — never committed.
  const debugDir = join(__dirname, 'debug')
  mkdirSync(debugDir, { recursive: true })
  const debugFile = join(debugDir, 'last-run.log')
  writeFileSync(
    debugFile,
    `LocalFlow bench — last run\n` +
      `provider=${args.provider} model=${modelLabel} size=${args.size} deployment=${args.deployment} runs=${args.runs} thinking=${args.thinking ?? 'default'}\n` +
      `host=${host.cpu} · ${host.ramGB} GB · ${host.gpu} · ${host.platform}\n` +
      `started=${new Date().toISOString()}${baseUrl ? ` base=${baseUrl}` : ''}\n\n`,
  )

  const results: Record<string, { passes: number; runs: number }> = {}
  const latencies: number[] = []

  for (const task of tasks) {
    let passes = 0
    for (let r = 0; r < args.runs; r++) {
      // Fresh assistant per run so conversation history never leaks between runs.
      const assistant = new LocalAssistant({ proxy: makeProxy(), llm: {}, modelSize: args.size })
      assistant.addDataset(DATASET_NAME, rows)
      assistant.setActiveDataset(DATASET_NAME)

      const steps: RunStep[] = []
      let crashed = false
      for (const turn of task.turns) {
        try {
          const t0 = Date.now()
          const res = await assistant.prompt(turn)
          latencies.push(Date.now() - t0)
          const exec = res.formula
            ? await executeFormula(res.formula, rows, datasets)
            : { ok: false, error: 'no formula returned', echartsOptions: [] as unknown[] }
          steps.push({ res, exec })
        } catch (e) {
          crashed = true
          console.warn(`  ! ${task.id} run ${r + 1}: ${e instanceof Error ? e.message : String(e)}`)
          break
        }
      }

      const passed = !crashed && steps.length === task.turns.length && task.check(steps, { rows })
      if (passed) passes++
      // Always persist this run's trace; echo failures to the console with --debug.
      appendFileSync(debugFile, formatRun(task, r + 1, args.runs, steps, passed))
      if (!passed && args.debug) {
        const last = steps[steps.length - 1]
        console.log(`\n----- DEBUG ${task.id} run ${r + 1} FAILED (full trace in ${debugFile}) -----`)
        console.log('formula:', last?.res.formula ? '\n' + last.res.formula : '(empty — model output likely did not parse)')
        console.log('answer/raw:', (last?.res.answer ?? '').slice(0, 1500))
        console.log('exec.ok:', last?.exec.ok, '| error:', last?.exec.error ?? '(none)')
        const d = last?.exec.data
        console.log('exec.data:', typeof d === 'string' ? d.slice(0, 1400) : (JSON.stringify(d) ?? String(d)).slice(0, 1400))
        console.log('-------------------------------------------\n')
      }
    }
    results[task.id] = { passes, runs: args.runs }
    console.log(`  ${task.id} [${task.column}]: ${passes}/${args.runs}`)
  }

  const date = new Date().toISOString()
  const record = {
    provider: args.provider,
    model: modelLabel,
    size: args.size,
    deployment: args.deployment,
    thinking: args.thinking ?? null,
    host,
    date,
    runs: args.runs,
    latencyMsMedian: median(latencies),
    tasks: results,
  }

  // Safety: an API key must never end up in a committed results file.
  if (args.apiKey && JSON.stringify(record).includes(args.apiKey)) {
    throw new Error('refusing to write results: API key leaked into the record')
  }

  const resultsDir = join(__dirname, 'results')
  mkdirSync(resultsDir, { recursive: true })
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, '_')
  const file = join(resultsDir, `${safe(args.provider)}-${safe(modelLabel)}-${safe(date)}.json`)
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n')

  const totalPass = Object.values(results).reduce((s, t) => s + t.passes, 0)
  const totalRuns = Object.values(results).reduce((s, t) => s + t.runs, 0)
  console.log(`\nsummary: ${totalPass}/${totalRuns} passing across ${tasks.length} tasks`)
  console.log(`latency: ${record.latencyMsMedian ?? '—'} ms median | hardware: ${host.cpu} · ${host.ramGB} GB · ${host.gpu} | os: ${host.platform}`)
  console.log(`written: ${file}`)
  console.log(`trace:   ${debugFile}   (full per-run trace of this run)`)
  console.log(`\nNext: npm run bench:report   (regenerates the tables in benchmarks.md)`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
