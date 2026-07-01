// Headless executor that mirrors the real LocalFlow sandbox closely enough to
// tell whether a model's formula actually runs and produces data/charts.
//
// The real sandbox (src/LocalAssistant buildSandboxDocumentFn) builds an
// AsyncFunction with this exact argument list and runs it inside an iframe with
// real ECharts/Leaflet/Tailwind. Here we run it in-process under Node with the
// same arg ORDER but lightweight stubs: a fake `echarts` that captures every
// setOption() payload, a fake `document` + synchronous `requestAnimationFrame`
// so chart code executes, and the real number parsers from core. That lets the
// task checkers inspect both the returned `data` and the captured chart series.
//
// Formulas are async function bodies, so `executeFormula` is async: a synchronous
// signature genuinely cannot await the formula's promise under Node.

import * as math from 'mathjs'
import { parseMoney, parseNum, splitCols } from '../src/sandboxHelpers'

export interface ExecuteResult {
  ok: boolean
  error?: string
  html?: string
  data?: unknown
  /** Every option object passed to a captured chart's setOption(), in call order. */
  echartsOptions: unknown[]
}

/** Build the AsyncFunction constructor (formulas are async bodies). */
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...vals: unknown[]) => Promise<unknown>

/** A DOM element stub: enough surface for typical chart/container code. */
function fakeElement(): Record<string, unknown> {
  return {
    style: {},
    getAttribute: () => null,
    setAttribute: () => {},
    appendChild: () => {},
    removeChild: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => fakeElement(),
    querySelectorAll: () => [] as unknown[],
    classList: { contains: () => false, add: () => {}, remove: () => {}, toggle: () => {} },
    innerHTML: '',
    textContent: '',
  }
}

/**
 * Execute one formula against `data` (+ secondary `datasets`) and report whether
 * it ran, plus anything it produced. Never rejects: a thrown formula resolves to
 * `{ ok: false, error }`. Result normalisation matches the real sandbox: a bare
 * string return is treated as `{ html: result }`.
 */
export async function executeFormula(
  formula: string,
  data: object[],
  datasets: Record<string, object[]>,
): Promise<ExecuteResult> {
  const capturedOptions: unknown[] = []

  // Fake chart returned by echarts.init(): records every setOption payload.
  const fakeChart = {
    setOption(o: unknown) {
      capturedOptions.push(o)
    },
    resize() {},
    dispose() {},
    on() {},
    off() {},
    getOption() {
      return capturedOptions[capturedOptions.length - 1]
    },
  }
  const echarts = {
    init: () => fakeChart,
    getInstanceByDom: () => fakeChart,
    registerTheme: () => {},
    registerMap: () => {},
    // Any echarts.graphic.X (LinearGradient, RadialGradient, …) → a no-op
    // constructor, so gradient-styled charts build and their setOption is captured
    // instead of throwing (and being swallowed) inside requestAnimationFrame.
    graphic: new Proxy({}, { get: () => function () { return {} } }),
  }

  // requestAnimationFrame runs its callback synchronously so deferred chart-
  // building code executes before the formula returns. Errors inside rAF are
  // swallowed: in the real iframe they'd surface as a console error, not a
  // formula-level throw.
  const requestAnimationFrame = (cb: (t: number) => void) => {
    try {
      cb(0)
    } catch {
      /* ignore */
    }
    return 0
  }
  const setTimeout = (cb: () => void) => {
    try {
      cb()
    } catch {
      /* ignore */
    }
    return 0 as unknown
  }

  const document = {
    getElementById: () => fakeElement(),
    querySelector: () => fakeElement(),
    querySelectorAll: () => [] as unknown[],
    createElement: () => fakeElement(),
    documentElement: { classList: { contains: () => false } },
    body: { appendChild: () => {} },
    head: { appendChild: () => {} },
  }

  const window = {
    devicePixelRatio: 1,
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    requestAnimationFrame,
    setTimeout,
  }

  // Capturing console: a silent sink (matches the sandbox's postMessage console).
  const consoleStub = { log: () => {}, info: () => {}, warn: () => {}, error: () => {} }

  // Formal sandbox arg list — order MUST match buildSandboxDocumentFn.
  const sandboxArgs = [
    'data',
    'datasets',
    'echarts',
    'L',
    'console',
    'XLSX',
    'jsPDF',
    'pdfData',
    'pdfjsLib',
    'pdfText',
    'parseMoney',
    'parseNum',
    'splitCols',
    'math',
  ]
  // Ambient globals the iframe provides but that aren't formal args.
  const ambientArgs = ['document', 'requestAnimationFrame', 'window', 'setTimeout', 'tailwind']

  const sandboxVals: unknown[] = [
    data,
    datasets,
    echarts,
    undefined, // L (Leaflet)
    consoleStub,
    undefined, // XLSX
    undefined, // jsPDF
    undefined, // pdfData
    undefined, // pdfjsLib
    '', // pdfText
    parseMoney,
    parseNum,
    splitCols,
    math,
  ]
  const ambientVals: unknown[] = [document, requestAnimationFrame, window, setTimeout, { refresh: () => {} }]

  try {
    const fn = new AsyncFunction(...sandboxArgs, ...ambientArgs, formula)
    let result = await fn(...sandboxVals, ...ambientVals)

    // Normalise like the real sandbox.
    if (typeof result === 'function') result = await (result as () => unknown)()
    if (typeof result === 'string') result = { html: result, data: null }

    const obj = result && typeof result === 'object' ? (result as Record<string, unknown>) : {}
    return {
      ok: true,
      html: typeof obj.html === 'string' ? obj.html : undefined,
      data: 'data' in obj ? obj.data : undefined,
      echartsOptions: capturedOptions,
    }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      echartsOptions: capturedOptions,
    }
  }
}
