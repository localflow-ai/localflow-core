# LocalFlow Core — Metadata-first AI Framework

[![npm](https://img.shields.io/npm/v/@localflow/core)](https://www.npmjs.com/package/@localflow/core)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Live demo](https://img.shields.io/badge/demo-live-brightgreen)](https://apps.localflow.fr/demo/)

---

## Table of contents

- [What is Metadata-first AI?](#what-is-metadata-first-ai)
  - [The metadata boundary](#the-metadata-boundary)
  - [Two-step execution](#two-step-execution)
  - [Key properties](#key-properties)
- [Architecture overview](#architecture-overview)
  - [What leaves the browser?](#what-leaves-the-browser)
  - [Limitations](#limitations)
- [Quick start](#quick-start--embedding-localassistant-in-your-app)
- [Use an actual proxy](#use-an-actual-proxy)
- [API Reference](#api-reference)
  - [`LocalAssistant`](#localassistant-api-reference)
    - [Constructor](#constructor)
    - [Configuration](#configuration)
    - [Datasets](#datasets)
    - [External APIs](#external-apis)
    - [Conversation & `prompt()`](#conversation)
    - [Analysis match hook](#analysis-match-hook)
    - [Events](#events)
  - [`Proxy` / `LocalProxy` / `ProxyClient`](#proxy-api-reference)
- [Building](#building)
- [Package structure](#package-structure)
- [Roadmap](#roadmap-highlights)
- [License](#license)

---

## What is Metadata-first AI?

In **metadata-first AI**, only metadata about your data ever reaches the LLM — column names, statistical samples, document structure. The actual rows, values, and documents stay on your machine. The model acts as a **code generator**: given a description of the data's shape, it writes analysis code that executes locally in a sandbox on your real data.

This is a different axis than the two approaches usually discussed:

- **Classical cloud AI** — sends raw data to the model. Powerful and flexible, but your data leaves your environment and every result is a fresh inference, non-deterministic by nature.
- **Local-model AI** (Ollama, llama.cpp, etc.) — runs the model on your device so data stays local, but you are constrained by what fits on your hardware, and results remain non-deterministic.

Metadata-first AI makes the constraint explicit: **only metadata crosses the inference boundary** — raw data never does. When using a cloud LLM, metadata (column names, statistics, document structure) does leave your machine, which is an acceptable exposure for most organisations. For the strictest privacy requirements, combining metadata-first AI with a self-hosted LLM eliminates even that: nothing crosses your infrastructure boundary. The generated code runs deterministically in your browser on your real data.

| | Classical cloud AI | Local-model AI | Metadata-first AI |
|---|---|---|---|
| Raw data stays local | ❌ | ✅ | ✅ |
| Metadata stays local | ❌ | ✅ | ⚠️ cloud / ✅ self-hosted |
| Computation executes locally | ❌ | ✅ | ✅ |
| Uses best available models | ✅ | Limited | ✅ |
| Compatible with self-hosted LLMs | ✅ | ✅ | ✅ |
| Results are deterministic | ❌ | ❌ | ✅ |
| Re-runs without AI (no tokens/GPU) | ❌ | ❌ | ✅ |
| Works on large datasets | ✅ | Limited | ✅ |

Typical use cases range from **"Talk to your Data"** on sensitive enterprise spreadsheets — where you want natural language querying without exposing values to the model — to large-scale geospatial analysis, document intelligence on confidential PDFs, and any analytical pipeline where deterministic, repeatable results matter.

### The metadata boundary

LocalFlow defines precisely what constitutes metadata for each data type:

- **Structured data** (CSV, Excel, CRM): column headers and statistical samples — enough for the LLM to write correct analysis code. Raw rows are never sent.
- **Documents** (PDF): the extracted text is needed so the LLM understands the document's structure and can write a reliable parser. Users can work with obfuscated or template documents to generate formulas, then run them locally on real documents — the LLM only needs the structure, not the actual values.

### Two-step execution

Code generation (step 1) and local execution (step 2) are invisible to the user — the assistant behaves like a regular AI assistant. The difference is that **generated analyses can be saved and re-run** on any compatible dataset without making another LLM call.

### Key properties

1. **Full AI power** — use the best available LLM to analyse complex, heterogeneous data
2. **Data safety** — raw data never reaches the LLM. Metadata (schema, statistics) leaves only for code generation; a self-hosted LLM removes even that exposure
3. **No hallucinated results** — outputs are computed from real data by deterministic code, not inferred by the model
4. **Scalable** — once generated, run the same analysis on large datasets as many times as needed, consuming no additional AI tokens
5. **Explainable** — the generated code is fully inspectable; any AI can explain why a formula works or debug why it fails
6. **Green and sustainable** — AI is used only for code generation, a one-time cost per analysis. Subsequent runs consume no AI inference at all, reducing dependence on energy-intensive infrastructure

---

## Architecture overview

```
┌─────────────────────────────────────────────────────┐
│                  Browser (client)                   │
│                                                     │
│  ┌─────────────────┐      ┌──────────────────────┐  │
│  │  Host App / UI  │      │      Sandbox         │  │
│  │  (React or any) │      │  formula execution   │  │
│  │                 │      │  charts / maps       │  │
│  │  LocalAssistant │◄────►│  fetch → proxy relay │  │
│  │  (vanilla JS)   │      └──────────────────────┘  │
│  └────────┬────────┘                                │
│           │ HTTPS (column stats + generated code)   │
└───────────┼─────────────────────────────────────────┘
            │
   ┌────────▼────────┐
   │ LocalFlow Proxy │  (manages keys, auth,
   │                 │   whitelists APIs,
   └────────┬────────┘   edge services: PDF, OCR...)
            │
            ├──────────────────┐─────────────────────┐
            │                  │                     │
   ┌────────▼────────┐ ┌───────▼───────┐ ┌───────────▼───────────┐
   │     LLM API     │ │ Whitelisted   │ │  Your CRM / ERP / DB  │
   └─────────────────┘ │ external APIs │ └───────────────────────┘
                       └───────────────┘
```

### What leaves the browser?

| Operation | Data sent | Where |
|-----------|-----------|-------|
| Tabular analysis — code generation | Column headers + statistics | 🟠 LLM |
| PDF extraction | Raw PDF bytes | 🔵 Proxy |
| PDF analysis — code generation | Extracted document text | 🟠 LLM |
| Analysis execution | Actual data | 🟢 Browser |
| External API calls (optional) | Query parameters only | 🔵 Proxy |

> 🟢 **Browser** — stays in your browser &nbsp;·&nbsp; 🔵 **Proxy** — goes to your server only and proxied APIs &nbsp;·&nbsp; 🟠 **LLM** — forwarded to the AI model via your proxy

### Limitations

Because the LLM only ever sees metadata — never the actual rows — there are tasks that a metadata-first approach cannot perform on its own. Inference excels at understanding natural language, translating free-form content, summarising documents, or spotting patterns across raw text. When those capabilities need to operate on the full dataset, a classical AI pipeline (one that sends the data to the model) remains the right tool.

LocalFlow is therefore a **complement to classical AI, not a replacement**. It opens up use cases that are out of reach for classical AI — large-scale data analysis without privacy exposure, deterministic and repeatable results, scalable execution at zero marginal AI cost — while leaving room for classical approaches where they are genuinely needed.

That boundary is not fixed. The proxy can expose tools — including LLM-powered ones — that operate on a carefully scoped subset of data, defined and controlled by the administrator or the user. A formula could, for example, call a proxy-hosted service that summarises a specific field or translates a column, without the LLM ever seeing the full dataset. This kind of extension requires intentional configuration of your proxy environment and its available tools, tailoring the setup to your specific use cases and acceptable data-sharing boundaries.

---

> [!TIP]
> **Want to see it in action?** Try the [LocalFlow online assistant example](https://apps.localflow.fr/demo/) — no installation needed. Source: [localflow-examples](https://github.com/localflow-ai/localflow-examples).

> 📄 For a deeper dive into these concepts, read the [LocalFlow white paper](https://localflow.fr/LocalFlow%20-%20white%20paper%20-%20en.pdf).

## Quick start — embedding `LocalAssistant` in your app

No server required — `LocalProxy` runs entirely in the browser and calls the LLM directly. See [localflow-examples](https://github.com/localflow-ai/localflow-examples) for complete React and vanilla JS apps you can run immediately.

### 1. Install

```bash
npm install @localflow/core
```

### 2. Create the assistant

```typescript
import { LocalProxy, LocalAssistant } from '@localflow/core'

// No server needed — LocalProxy calls the LLM directly from the browser
const proxy = new LocalProxy()

const assistant = new LocalAssistant({
  proxy,
  llm: {
    protocol: 'gemini',                // 'gemini' | 'openai' | 'anthropic'
    model: 'gemini-3-flash-preview',   // optional, this is the default for Gemini
  },

  // Point to the div where formula results should be rendered.
  // Accepts an HTMLElement, a CSS selector string, or a factory function.
  resultContainer: '#result',
})

// Pass the user's API key — stored locally, never sent to any third party
// NOTE: automatically encrypted when using an actual proxy
await assistant.setLlmApiKey('AIza...')

// Persist LLM config whenever it changes (user sets a new key, model, etc.)
assistant.on('llm:change', (llm) => {
  if (llm.apiKey) localStorage.setItem('llm-key', llm.apiKey)
})
```

To restore a key across page loads, pass it at construction:

```typescript
const assistant = new LocalAssistant({
  proxy,
  llm: { protocol: 'gemini', apiKey: localStorage.getItem('llm-key') ?? '' },
  resultContainer: '#result',
})
```

### 3. Load your data

```typescript
// Tabular data — from any source: CSV parse, DB query, API response, etc.
assistant.addDataset('portfolio', portfolioRows)   // rows: Record<string, unknown>[]
assistant.addDataset('market',    marketRows)

// Mark which dataset is the "active" one (the `data` variable in formulas)
assistant.setActiveDataset('portfolio')
```

### 4. Send a message and render the result

With `resultContainer` configured, the assistant takes care of everything — creating the iframe, setting sandbox permissions, and relaying proxied API calls. No boilerplate needed.

```typescript
assistant.on('message', (response) => {
  // Show response.answer in your chat UI
  appendChatBubble(response.answer)
})

assistant.on('formula:done', ({ data }) => {
  // Optional: react to the formula's output data
  console.log('Analysis result:', data)
})

// Send a message — the LLM generates a formula, and the assistant
// renders it automatically in the configured resultContainer.
const response = await assistant.prompt('Show me the allocation by asset class')
```

You can change the result container at any time:

```typescript
assistant.resultContainer = document.getElementById('result')
// or: assistant.resultContainer = '#result'
// or: assistant.resultContainer = () => document.querySelector('.panel.active')
```

### 5. Save and replay formulas (optional)

Generated formulas are deterministic — you can save them and re-run on any compatible dataset without an additional LLM call.

```typescript
// Get the formula from the last response
const formula = assistant.getLastFormula()

// Save it to your catalog...
saveToCatalog({ formula, title: response.title, description: response.description })

// ...and replay it later
assistant.executeFormula(savedFormula)
```

### 6. Register a semantic analysis-match hook (optional)

This lets the assistant inject a relevant past analysis as a system-prompt example before calling the LLM, improving output quality.

```typescript
assistant.setAnalysisMatchHook(async (query, ctx) => {
  const analyses = catalogLoad()        // your catalog store
  return findBestMatch(query, analyses, ctx.activeColumns)
})
```

---

## Use an actual proxy

`LocalProxy` is designed for local development and quick prototyping. For production — where you need session management, API governance, PDF extraction, BYOK key encryption, rate limiting, and data flow monitoring — replace it with a [`ProxyClient`](https://github.com/localflow-ai/localflow-proxy) connected to a [LocalFlow proxy](https://github.com/localflow-ai/localflow-proxy) server.

The proxy handles:

- **Security and session management** — authenticates users against your business systems (CRM, ERP, or guest sessions), manages session tokens, and encrypts API keys so secrets are never exposed to the browser
- **API governance** — defines which external APIs formulas may call; supports BYOK, per-source throttling, URL whitelisting, and OAuth 2.0 token exchange
- **Server-side edge services** — PDF text extraction, OCR, and other tasks better suited to a server than a browser
- **LLM bridge** — decrypts the user's API key at request time and forwards generation requests to the LLM
- **Data flow monitoring** — tracks and audits what data enters and leaves the sandbox

`LocalAssistant` accepts any implementation of the `Proxy` interface — switching from `LocalProxy` to `ProxyClient` requires no other changes.

### Connect to the proxy

```typescript
import { ProxyClient, LocalAssistant } from '@localflow/core'

const proxy = new ProxyClient('https://your-proxy.example.com')

// Authenticate — stores the session token on the proxy instance
await proxy.connect('odoo', { url, database, login, password })
// or for a public/guest session:
await proxy.connect('public', {})

// Save the token so the session survives a page reload
localStorage.setItem('proxy-token', proxy.token!)

// Restore on next load
const proxy = new ProxyClient('https://your-proxy.example.com', localStorage.getItem('proxy-token'))
await proxy.getSessionInfo()  // throws if expired — re-authenticate if needed

const assistant = new LocalAssistant({ proxy, llm: { protocol: 'gemini' }, resultContainer: '#result' })
```

**Quick testing:** a hosted instance is available at `https://backoffice.daquota.io/demo` — no account needed. You can start with a guest (public) session, or authenticate against your own CRM if you want to test with real data. That said, you probably don't want to point your production CRM at an instance you don't control; use a sandbox or test environment instead.

**Self-hosting:** for production use, run your own instance — see the [localflow-proxy](https://github.com/localflow-ai/localflow-proxy) repository for setup instructions.

### PDF extraction

PDF extraction requires a proxy (not available with `LocalProxy`).

```typescript
// Extract text via the proxy, then load as a dataset
const { text, pageCount } = await proxy.extractPdf(pdfBuffer)
assistant.addPdfDataset('report.pdf', pdfBuffer, text, pageCount)

assistant.setActiveDataset('report.pdf')
const response = await assistant.prompt('Summarise the key figures')
```

Pass an optional `searchString` to receive only pages matching the query (plus one page of context either side):

```typescript
const { text, pageCount } = await proxy.extractPdf(pdfBuffer, 'revenue')
```

### Wire up external APIs (optional)

The proxy admin configures which external APIs analysis formulas may call. Users can opt in/out and supply their own API keys (BYOK) per API.

```typescript
// Fetch the list of APIs the proxy admin has whitelisted
const apis = await assistant.fetchApiConfigs()

// Activate one for use in formulas
assistant.activateApi('overpass')

// If an API requires a user-supplied key (BYOK):
// pass the plain key — the assistant encrypts it via the proxy internally.
await assistant.setApiUserKey('my-api', plainApiKey)

// Persist API preferences whenever they change
assistant.on('prefs:change', (prefs) => {
  localStorage.setItem('api-prefs', JSON.stringify(prefs))
})
```

---

## API Reference

### `LocalAssistant` API reference

#### Constructor

```typescript
new LocalAssistant(config: LocalAssistantConfig)
```

```typescript
interface LocalAssistantConfig {
  proxy: Proxy             // any Proxy implementation — LocalProxy or ProxyClient
  llm: LLMConfig           // LLM backend configuration
  darkMode?: boolean       // passed to the formula sandbox (default: false)
  apiPreferences?: ApiPreference[]    // previously persisted prefs (from 'prefs:change')
  resultContainer?: ResultContainer   // where to render formula results
  sandboxPermissions?: string[]       // iframe sandbox flags (see defaults below)
  sandboxTheme?: Record<string, unknown>    // Tailwind theme object injected into the sandbox (see below)
  pdfFormulaRevision?: boolean        // silent self-correction on first PDF query (default: false)
  formulaHealingRetries?: number      // silent retries on JS syntax errors (default: 1)
}

interface LLMConfig {
  // --- BYOK (bring your own key) ---
  protocol?: 'gemini' | 'openai' | 'anthropic'  // 'openai' covers any OpenAI-compatible endpoint
  model?: string           // model ID — falls back to protocol default if omitted
  apiKey?: string          // encrypted key restored from storage — set via setLlmApiKey()
  baseUrl?: string         // override the protocol's default endpoint (LocalProxy only)

  // --- Server-managed model (ProxyClient only) ---
  modelId?: string         // references a model defined in the proxy's llm-configs.json
                           // the server resolves protocol/model/apiKey/baseUrl from it
}

// resultContainer accepts any of:
type ResultContainer = HTMLElement | string | (() => HTMLElement | null)
//                     ^ element     ^ selector  ^ factory (evaluated at render time)

// Default sandbox permissions:
const DEFAULT_SANDBOX = [
  'allow-scripts', 'allow-downloads', 'allow-modals',
  'allow-popups',  'allow-popups-to-escape-sandbox',
]
```

---

#### Configuration

| Property / Method | Type / Returns | Description |
|-------------------|----------------|-------------|
| `assistant.llm` | `LLMConfig` | Read or replace the LLM configuration. Emits `'llm:change'`. |
| `assistant.darkMode` | `boolean` | Toggle dark mode in the analysis sandbox. |
| `assistant.resultContainer` | `ResultContainer` | Where formula results are rendered. |
| `assistant.sandboxPermissions` | `string[]` | iframe sandbox flags. |
| `assistant.pdfFormulaRevision` | `boolean` | When `true`, the first formula for a new PDF is silently run, its logs collected, and a second LLM call revises it before anything is shown to the user. |
| `sandboxTheme` _(constructor only)_ | `Record<string, unknown>` | Tailwind `theme` object injected into the sandbox CDN config before it initialises. Use it to align generated UI with your host app's palette: override `gray` shades for dark-mode card surfaces, define a `primary` color referenceable via `bg-primary` / `text-primary`, etc. The sandbox body also picks up `dark:bg-gray-900 dark:text-gray-100` automatically, so setting `gray[900]` and `gray[100]` covers the full background. Works with any host framework — just translate your design tokens to Tailwind color values. |
| `assistant.proxy` _(read-only)_ | `Proxy` | The proxy implementation passed at construction. |
| `setLlmApiKey(plainKey)` | `Promise<void>` | Encrypt a plain API key via the proxy and store it. Emits `'llm:change'`. |

---

#### Datasets

Datasets are ordered key-value pairs: name → array of row objects (tabular) or PDF document (with extracted text). The **active dataset** is exposed as the `data` variable inside formula code; all datasets are accessible via `datasets['name']`.

| Method | Returns | Description |
|--------|---------|-------------|
| `addDataset(name, rows)` | `void` | Add or replace a tabular dataset. First added becomes active. |
| `addPdfDataset(name, buffer, extractedText, pageCount)` | `void` | Add a PDF document. Pass the text returned by `proxy.extractPdf()`. |
| `removeDataset(name)` | `void` | Remove a dataset. Active dataset moves to next available. |
| `updateDataset(name, rows)` | `void` | Replace rows for an existing dataset. |
| `getDataset(name)` | `rows \| undefined` | Read rows for a named dataset. |
| `getDatasets()` | `Record<string, rows[]>` | All datasets as a plain object. |
| `setActiveDataset(name)` | `void` | Mark a dataset as active (`data` variable in formulas). |
| `getActiveDataset()` | `{ name, type, rows, columns } \| null` | Current active dataset. `type` is `'table'` or `'pdf'`. |
| `getActivePdfBuffer()` | `ArrayBuffer \| null` | Raw bytes of the active PDF. |
| `getActivePdfExtractedText()` | `string` | Extracted text of the active PDF. |
| `getActivePdfPageCount()` | `number` | Page count of the active PDF. |
| `clearDatasets()` | `void` | Remove all datasets and reset active. |

```typescript
assistant.addDataset('Sales Q1', salesRows)
assistant.addDataset('Products', productRows)
assistant.setActiveDataset('Sales Q1')

const active = assistant.getActiveDataset()
// { name: 'Sales Q1', rows: [...], columns: ['id', 'product', 'amount', ...] }
```

---

#### External APIs

The proxy admin configures which external APIs analysis formulas may call. Users can opt in/out and supply their own API keys (BYOK) per API.

| Method | Returns | Description |
|--------|---------|-------------|
| `fetchApiConfigs()` | `Promise<ApiConfig[]>` | Fetch available APIs from the proxy and store them. |
| `setApiConfigs(configs)` | `void` | Set API configs without a network call. |
| `getApiConfigs()` | `ApiConfig[]` | Currently stored API configs. |
| `setApiPreferences(prefs)` | `void` | Bulk-set user preferences (enabled flags + BYOK keys). |
| `getApiPreferences()` | `ApiPreference[]` | Current user preferences. |
| `activateApi(id)` | `void` | Enable an API for use in formulas. |
| `deactivateApi(id)` | `void` | Disable an API. |
| `setApiUserKey(id, plainKey)` | `Promise<void>` | Encrypt a BYOK key via the proxy and store it. Pass the plain key — encryption is handled internally. |
| `getActivatedApis()` | `ActivatedApi[]` | APIs that are currently active (forced or user-enabled). |

---

#### Conversation

| Method | Returns | Description |
|--------|---------|-------------|
| `prompt(message, opts?)` | `Promise<AssistantResponse>` | Send a user message. Builds system prompt, calls the LLM, appends to history, emits `'message'`. |
| `getHistory()` | `ConversationTurn[]` | Full conversation history. |
| `setHistory(turns)` | `void` | Replace the conversation history (e.g. to restore a session). |
| `appendHistory(turn)` | `void` | Append a single turn. |
| `clearHistory()` | `void` | Reset conversation to empty. |
| `getLastFormula()` | `string \| null` | Formula code from the most recent model response. |
| `buildCurrentSystemPrompt(example?)` | `string` | Build the system prompt for the current state without sending it. |

##### `prompt()` options

```typescript
await assistant.prompt('Break down revenue by region', {
  exampleAnalysis: {      // inject a catalog analysis as a system-prompt example
    formula: '...',
    title: 'Revenue by country (bar chart)',
    description: '...',
  },
})
```

##### `AssistantResponse` shape

```typescript
interface AssistantResponse {
  answer: string          // HTML description shown before the formula runs
  formula: string         // JS code to execute in the sandbox
  title?: string          // short title for the analysis
  description?: string    // longer functional description
  dependencies?: {        // declared data dependencies
    data: string[]        // columns accessed on the active dataset
    datasets: Record<string, string[]>  // columns accessed per named dataset
  }
  systemPrompt?: string   // snapshot of the system prompt used
}
```

---

##### `executeFormula(formula)`

Renders a formula in the configured `resultContainer`. Creates the sandboxed iframe, applies `sandboxPermissions`, wires up the proxy fetch relay, and emits `formula:done` / `formula:error`. Called automatically by `prompt()` when `resultContainer` is set.

```typescript
// Manual execution (e.g. replaying a catalog analysis)
assistant.executeFormula(savedAnalysis.formula)
```

##### `destroy()`

Removes the managed iframe and cleans up all event listeners. Call when the assistant is no longer needed.

```typescript
assistant.destroy()
```

---

#### Analysis match hook

Register a function that the assistant calls before each LLM request to find a semantically similar past analysis. The result is injected into the system prompt as an example, improving output quality for recurring analysis patterns.

```typescript
assistant.setAnalysisMatchHook(async (query, context) => {
  // context: { history, datasets, activeDatasetName, activeColumns }
  const best = await mySemanticSearch(query, myCatalog)
  if (!best || best.score < 0.3) return null
  return { analysis: best.formula, score: best.score }
})

// Call it directly (e.g. to check before showing a suggestion UI):
const match = await assistant.resolveAnalysisMatch('Show portfolio heatmap')
```

---

#### Events

```typescript
assistant.on('message', (response: AssistantResponse) => {
  console.log('Formula ready:', response.formula)
})

assistant.on('dataset:change', () => {
  renderTabBar(assistant.getDatasets())
})

// Persist LLM config whenever it changes
assistant.on('llm:change', (llm: LLMConfig) => {
  if (llm.apiKey) localStorage.setItem('llm-key', llm.apiKey)
})

// Persist API preferences whenever they change — covers activateApi, deactivateApi,
// setApiPreferences, and setApiUserKey (which encrypts BYOK keys before storing).
assistant.on('prefs:change', (prefs: ApiPreference[]) => {
  localStorage.setItem('api-prefs', JSON.stringify(prefs))
})

assistant.off('message', myListener)
```

| Event | Payload | When |
|-------|---------|------|
| `message` | `AssistantResponse` | After each successful LLM response |
| `dataset:change` | _(none)_ | After any dataset add / remove / update / clear |
| `formula:done` | `{ data: unknown }` | Formula finished executing; `data` is the formula's returned `data` field |
| `formula:error` | `{ message: string }` | Formula threw or called `console.error` |
| `llm:change` | `LLMConfig` | After `setLlmApiKey()` or `assistant.llm = ...`. The payload contains the encrypted key — safe to persist and pass back via `llm.apiKey` at construction. |
| `prefs:change` | `ApiPreference[]` | After any API preference mutation (`activateApi`, `deactivateApi`, `setApiPreferences`, `setApiUserKey`). The payload contains encrypted BYOK keys — safe to persist as-is and pass back via `apiPreferences` at construction. |
| `configs:change` | `ApiConfig[]` | After API configs are loaded or updated via `fetchApiConfigs()` or `setApiConfigs()`. |
| `history:reset` | _(none)_ | Conversation history was cleared (e.g. because the active PDF changed). |
| `api:blocked` | `{ url, hostname, apiConfig \| null }` | Formula called a URL not in the activated API list and the request failed. `apiConfig` is set if the API is known but inactive, `null` if completely unknown. |
| `api:error` | `{ url, hostname, apiConfig, reason }` | An active API returned a JSON error body (e.g. expired key, quota exceeded). `reason` is extracted from the response. |
| `data:local` | `{ data: string, action: string }` | An action completed entirely in the browser. E.g. file loaded from disk, formula executed in sandbox. Emitted by the app layer. |
| `data:proxy` | `{ data: string, action: string }` | Data was sent to the proxy server but not to the LLM. E.g. PDF extraction. Emitted by the app layer. |
| `data:llm` | `LlmDataPayload` | Data was forwarded to the LLM. Categorical payload — no display strings. `kind` is `'table'`, `'pdf'`, or `'text'`; always includes `query` (raw user message) and `dataset` (file/dataset name). Table events include `columns: number`; PDF events include `pages: number`. Import the type: `import type { LlmDataPayload } from '@localflow/core'`. |
| `data:api-proxy` | `ApiProxyPayload` | A formula fetch was routed through the api-proxy — fired on every call (success and failure). Includes `url`, `method`, `body` (raw request body — what left the browser), `apiConfig` (matched API definition or `null` if unrecognised), and `status` (HTTP response status; `undefined` on network error). Import the type: `import type { ApiProxyPayload } from '@localflow/core'`. |

---

### `Proxy` API reference

`Proxy` is the interface that both `LocalProxy` and `ProxyClient` implement. `LocalAssistant` depends only on this interface — you can supply any conforming implementation.

```typescript
import type { Proxy } from '@localflow/core'

interface Proxy {
  readonly token: string | null

  isConnected(): boolean
  connect(type?: string, config?: Record<string, unknown>): Promise<void>
  getSessionInfo(): Promise<unknown>

  isEncrypted(str: string): boolean
  encryptMessage(message: string): Promise<string>
  decryptMessage(message: string): Promise<string>

  callLLM(request: LLMRequest): Promise<LLMResponse>
  getAvailableLLMs(): Promise<LLMModelInfo[]>

  getApiConfigs(): Promise<ApiConfig[]>
  proxyApiCall(url: string, method: string, headers: Record<string, string>, body: string): Promise<Response>

  extractPdf(buffer: ArrayBuffer, searchString?: string): Promise<{ text: string; pageCount: number }>

  listObjectTypes(): Promise<CrmObjectType[]>
  getObjectMetadata(objectType: string): Promise<CrmObjectType>
  getData(objectType: string, fields: string[]): Promise<Record<string, unknown>[]>
}
```

#### `LocalProxy`

Browser-only implementation. No server required — suitable for local development, testing, and demos.

```typescript
import { LocalProxy } from '@localflow/core'

new LocalProxy(config?: {
  apis?: ApiConfig[]
  geminiBaseUrl?: string         // override Gemini API base URL (testing / custom deployments)
  geminiApiKey?: string          // baked-in Gemini key used when no key is set on the assistant
  rateLimit?: {
    maxPerDay: number            // per-browser daily cap (tracked in localStorage)
    storageKey?: string          // localStorage key prefix — defaults to '_lf_rl'
  }
})
```

**`geminiApiKey`** — a fallback Gemini key used when the assistant has no key set. Useful for demos where you want users to try the app without supplying their own key. The user's own key (set via `assistant.setLlmApiKey()`) always takes precedence.

**`rateLimit`** — per-browser daily cap enforced before each `callLLM` call when using the demo key. When the limit is reached, `callLLM` throws `LocalProxyRateLimitError`. Pair with `geminiApiKey` to prevent a single user from exhausting a shared demo key for everyone.

```typescript
import { LocalProxy, LocalProxyRateLimitError, LocalAssistant } from '@localflow/core'

const proxy = new LocalProxy({
  geminiApiKey: 'AIza...',       // shared demo key — visible in DevTools, use a limited one
  rateLimit: { maxPerDay: 20 },  // generous enough to evaluate, stingy enough to protect the key
})
const assistant = new LocalAssistant({ proxy, llm: { protocol: 'gemini' } })

try {
  await assistant.prompt('Show me the top 10 by revenue')
} catch (err) {
  if (err instanceof LocalProxyRateLimitError) {
    // show UI asking the user to enter their own key
  }
}
```

`LocalProxy` supports three protocols — calls go directly from the browser to the provider's API:

| Protocol | `llm.protocol` | Default model | Notes |
|----------|----------------|---------------|-------|
| Gemini | `'gemini'` | `gemini-3-flash-preview` | `geminiApiKey` + rate limiting apply |
| OpenAI (or compatible) | `'openai'` | `gpt-4o` | Any OpenAI-compatible endpoint via `llm.baseUrl` |
| Anthropic | `'anthropic'` | `claude-opus-4-5` | Extended thinking supported via `options.thinking` |

| Behaviour | Notes |
|-----------|-------|
| `callLLM` | Calls the LLM provider directly from the browser. For Gemini, uses `geminiApiKey` if no key is set and applies the rate limit. |
| `getAvailableLLMs` | Returns `[]` — user configures the model directly via `LLMConfig`. |
| `encryptMessage` / `decryptMessage` | No-ops — the key is stored and used as plain text |
| `extractPdf` | Throws — PDF extraction is not available in standalone mode |
| `listObjectTypes` / `getObjectMetadata` / `getData` | Return empty results — no CRM access |
| `connect` / `getSessionInfo` | No-ops — no session management |

> Not for production use. `LocalProxy` emits a console warning to remind you.

#### `ProxyClient`

HTTP client for a [LocalFlow proxy](https://github.com/localflow-ai/localflow-proxy) server. Implements the full `Proxy` interface and adds session management.

```typescript
import { ProxyClient } from '@localflow/core'

const proxy = new ProxyClient(baseUrl, token?)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `baseUrl` | `string` | LocalFlow proxy base URL (e.g. `'https://backoffice.daquota.io/demo'`) |
| `token` | `string \| null` | Optional — restore a previously saved session token |

##### Session

| Method | Returns | Description |
|--------|---------|-------------|
| `connect(type, config)` | `Promise<void>` | Authenticate and store the session token. `type` is `'odoo'`, `'salesforce'`, or `'public'`. `config` contains connector-specific credentials. |
| `getSessionInfo()` | `Promise<unknown>` | Verify the current session. Throws if expired or not authenticated. |
| `isConnected()` | `boolean` | `true` if a session token is stored. |
| `proxy.token` | `string \| null` | The current session token — set by `connect()`, readable for persistence. |
| `proxy.baseUrl` | `string` | The proxy base URL — mutable, can be changed before calling `connect()`. |

##### Encryption

| Method | Returns | Description |
|--------|---------|-------------|
| `isEncrypted(str)` | `boolean` | `true` if the string is in the proxy-encrypted format. |
| `encryptMessage(plainText)` | `Promise<string>` | Encrypt a string via the proxy. The result is safe to store and pass to the assistant. |
| `decryptMessage(cipherText)` | `Promise<string>` | Decrypt a proxy-encrypted string. |

> You rarely need to call these directly — `assistant.setLlmApiKey()` and `assistant.setApiUserKey()` handle encryption internally.

##### PDF extraction

| Method | Returns | Description |
|--------|---------|-------------|
| `extractPdf(buffer, searchString?)` | `Promise<{ text, pageCount }>` | Extract text from a PDF via the proxy. Pass an optional `searchString` to receive only pages matching the query (plus one page of context either side). |

##### CRM

| Method | Returns | Description |
|--------|---------|-------------|
| `listObjectTypes()` | `Promise<CrmObjectType[]>` | List all available CRM object types (without fields). |
| `getObjectMetadata(objectType)` | `Promise<CrmObjectType>` | Fetch full metadata for one object type, including its fields. |
| `getData(objectType, fields)` | `Promise<Record<string, unknown>[]>` | Fetch rows for a CRM object type. |

```typescript
const types = await proxy.listObjectTypes()
const meta  = await proxy.getObjectMetadata('res.partner')
const rows  = await proxy.getData('res.partner', ['name', 'email', 'country_id'])
```

---

## Building

```bash
cd localflow-core
npm install
npm run build   # tsc → dist/
npm run dev     # tsc --watch (development)
```

The standalone `tsc` build produces `dist/` with `.js` and `.d.ts` files and is needed when publishing the library to npm. During development inside the monorepo, `localflow-app` uses a Vite alias pointing to the TypeScript source directly — no pre-build required.

## Package structure

```
localflow-core/
├── package.json          # name: "@localflow/core"
├── tsconfig.json         # emits dist/ with .js + .d.ts
└── src/
    ├── index.ts          # public exports
    ├── LocalAssistant.ts # the core class
    ├── Proxy.ts          # Proxy interface contract
    ├── LocalProxy.ts     # browser-only Proxy implementation
    ├── ProxyClient.ts    # HTTP proxy client
    ├── theme.ts          # default sandbox Tailwind theme
    └── types.ts          # all public TypeScript interfaces
```

---

## Roadmap highlights

- [ ] Additional LLM backends (Mistral, Ollama)
- [ ] Interactive formula results (action buttons returned by formulas)
- [ ] Async / streaming formula execution

### Recently shipped

- [x] **Multi-protocol LLM support** — Gemini, OpenAI (and compatible endpoints), Anthropic
- [x] **Published to npm** — available as `@localflow/core`
- [x] **PDF document support** — PDFs as first-class datasets; text extracted via the proxy, full document text injected into LLM context
- [x] **Data flow awareness** — `data:local` / `data:proxy` / `data:llm` events; animated status chip in the header; session history popover; sandbox safety indicator
- [x] **Configurable proxy URL** — proxy URL configurable at runtime; persisted in localStorage
- [x] **CRM connectors** — Odoo and Salesforce authentication and data loading via `ProxyClient`
- [x] **Formula self-healing** — `formulaHealingRetries` config option; syntax errors are caught and silently retried before returning to the caller (default: 1)

---

## License

Apache 2.0 — see [LICENSE](LICENSE) for the full text.

Copyright (c) 2026 LocalFlow (localflow.fr)
