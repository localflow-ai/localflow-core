# LocalFlow — Local-first AI Assistant

> **[→ Try the live demonstrator](https://apps.daquota.io/localflow/)** &nbsp;·&nbsp; **MIT License** — See [LICENSE](#license) at the bottom of this file.

---

## What is Local-first AI?

Most "AI on your data" products work by sending your data to a cloud service. LocalFlow takes the opposite approach: **all data stays in the browser**. The AI generates JavaScript analysis code, and that code executes locally in a sandbox — your raw data never reaches the LLM.

### The LLM as a one-time code generator

With Local-First AI, the LLM acts as a **code generator**, not a data processor. LocalFlow sends as little as possible to make that generation work:

- **Structured data** (CSV, Excel, CRM): column headers and statistical samples are enough for the LLM to write correct analysis code. Raw rows are never sent.
- **Documents** (PDF): the extracted text is needed so the LLM understands the document's structure and can write a reliable parser. Users can work with obfuscated or template documents to generate formulas, then run them locally on real documents — the LLM only needs the structure, not the actual values.

The same principle extends to RAG and semantic querying: queries and retrieval code can be pre-generated once and executed locally on any dataset thereafter.

### Transparent two-step process

Code generation (step 1) and local execution (step 2) are invisible to the user — the assistant behaves like a regular AI assistant. The difference is that **generated analyses can be saved and re-run** on any compatible dataset without making another LLM call. The demonstrator app includes a **catalog** for exactly this: save an analysis once, execute it locally as many times as needed.

### Key properties

1. **Full AI power** — use LLM prompting and inference to analyse complex, heterogeneous data
2. **Data safety** — sensitive data stays local even when using a cloud LLM; a self-hosted LLM removes the last network hop entirely
3. **No hallucinated results** — the human-in-the-loop process means outputs are computed from real data by deterministic code, not inferred by the model
4. **Scalable** — once generated, run the same analysis on large datasets as many times as needed, consuming no additional AI tokens
5. **Explainable** — the generated code is fully inspectable; any AI can explain why a formula works or debug why it fails
6. **Green and sustainable** — by using AI only in the code-generation phase, Local-First AI reduces dependence on heavy inference infrastructure. Running analyses locally means fewer round-trips to AI datacenters, whose energy footprint is a growing environmental concern

> 📄 For a deeper dive into the Local-First AI concepts, read the [LocalFlow white paper](https://localflow.fr/LocalFlow%20-%20white%20paper%20-%20en.pdf).

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

### Packages

| Path | Role |
|------|------|
| `localfirst-ai-lib/` | **`LocalAssistant` class** — the reusable library. Framework-agnostic, no UI dependencies. Published as `localfirst-ai`. |
| `localflow-app/` | **Demonstrator app** — a React + Vite application that embeds `LocalAssistant` and shows a full data-analysis workflow: file/CRM loading, conversation panel, analysis catalog, semantic catalog matching. |

The two packages are kept separate so that `localfirst-ai-lib/` can be published as an independent npm package and embedded in any framework.

---

## Quick start — embedding `LocalAssistant` in your app

### 1. Install dependencies

```bash
npm install   # from the repo root — installs both workspaces
```

> Until the package is published to npm, reference `localfirst-ai-lib/` via a path alias (see `localflow-app/vite.config.ts` for an example).

### 2. Set up the proxy

The assistant requires a [LocalFlow proxy](https://github.com/localflow-fr) instance.  
The proxy handles:
- LLM API key encryption and forwarding
- Whitelisting of external APIs callable from analysis formulas
- Session-based authentication

For development you can self-host it locally; for production use the hosted instance at `https://backoffice.daquota.io/v1` (requires an account).

### 3. Authenticate with the proxy

```typescript
import { ProxyClient } from 'localfirst-ai'

const proxy = new ProxyClient('https://backoffice.daquota.io/v1')

// Authenticate — stores the session token on the proxy instance
await proxy.connect('odoo', { url, database, login, password })
// or for a public/guest session:
await proxy.connect('public', {})
```

### 4. Instantiate and configure

```typescript
import { LocalAssistant, type ApiPreference, type LLMConfig } from 'localfirst-ai'

// Restore previously persisted preferences from storage
let savedPrefs: ApiPreference[] = []
try { savedPrefs = JSON.parse(localStorage.getItem('api-prefs') ?? '[]') } catch { /* ignore */ }

const assistant = new LocalAssistant({
  proxy,                                           // authenticated proxy client
  llm: {
    type: 'gemini',
    apiKey: localStorage.getItem('llm-key') ?? '', // restored encrypted key — empty on first use
    model: 'gemini-3-flash-preview',               // optional, this is the default
  },
  darkMode: false,
  apiPreferences: savedPrefs,

  // Point to the div where formula results should be rendered.
  // Accepts an HTMLElement, a CSS selector string, or a factory function.
  resultContainer: '#result',
})

// Persist LLM config whenever it changes (user sets a new key, model, etc.)
assistant.on('llm:change', (llm: LLMConfig) => {
  if (llm.apiKey) localStorage.setItem('llm-key', llm.apiKey)
})

// Persist API preferences whenever they change
assistant.on('prefs:change', (prefs: ApiPreference[]) => {
  localStorage.setItem('api-prefs', JSON.stringify(prefs))
})
```

When the user enters their Gemini API key for the first time, pass it plain — the assistant encrypts it via the proxy internally:

```typescript
await assistant.setLlmApiKey('AIza...')
```

### 5. Load your data

```typescript
// Tabular data — from any source: DB query, CSV parse, API response, etc.
assistant.addDataset('portfolio', portfolioRows)   // rows: Record<string, unknown>[]
assistant.addDataset('market',    marketRows)

// PDF documents — extract text via the proxy, then load
const { text, pageCount } = await proxy.extractPdf(pdfBuffer)
assistant.addPdfDataset('report.pdf', pdfBuffer, text, pageCount)

// Mark which dataset is the "active" one (the `data` variable in formulas)
assistant.setActiveDataset('portfolio')
```

### 6. Send a message and render the result

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

// Track what leaves the browser — see the Events reference for data:local/proxy/llm
assistant.on('data:llm', ({ data, action }) => {
  console.log(`Sent to AI: ${data} — ${action}`)
})

// Send a message — the LLM generates a formula, and the assistant
// renders it automatically in the configured resultContainer.
const response = await assistant.prompt('Show me the allocation by asset class')

// You can also execute a formula directly (e.g. from a saved catalog):
assistant.executeFormula(savedFormula)
```

You can change the result container at any time:

```typescript
assistant.resultContainer = document.getElementById('result')
// or: assistant.resultContainer = '#result'
// or: assistant.resultContainer = () => document.querySelector('.panel.active')
```

### 7. Wire up external APIs (optional)

```typescript
// Fetch the list of APIs the proxy admin has whitelisted
const apis = await assistant.fetchApiConfigs()

// Activate one for use in formulas
assistant.activateApi('overpass')

// If an API requires a user-supplied key (BYOK):
// pass the plain key — the assistant encrypts it via the proxy internally.
await assistant.setApiUserKey('my-api', plainApiKey)
```

### 8. Register a semantic analysis-match hook (optional)

This lets the assistant inject a relevant past analysis as a system-prompt example before calling the LLM, improving output quality.

```typescript
// These helpers live in the demonstrator app (localflow-app/src/lib/)
import { findBestMatch } from '@/lib/semanticSearch'
import { catalogLoad } from '@/lib/analysisCatalog'

assistant.setAnalysisMatchHook(async (query, ctx) => {
  const analyses = catalogLoad()        // or your own catalog store
  return findBestMatch(query, analyses, ctx.activeColumns)
})
```

---

## `ProxyClient` API reference

```typescript
import { ProxyClient } from 'localfirst-ai'

const proxy = new ProxyClient(baseUrl, token?)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `baseUrl` | `string` | LocalFlow proxy base URL (e.g. `'https://backoffice.daquota.io/v1'`) |
| `token` | `string \| null` | Optional — restore a previously saved session token |

### Session

| Method | Returns | Description |
|--------|---------|-------------|
| `connect(type, config)` | `Promise<void>` | Authenticate and store the session token. `type` is `'odoo'`, `'salesforce'`, or `'public'`. `config` contains connector-specific credentials. |
| `getSessionInfo()` | `Promise<unknown>` | Verify the current session. Throws if expired or not authenticated. |
| `isConnected()` | `boolean` | `true` if a session token is stored. |
| `proxy.token` | `string \| null` | The current session token — set by `connect()`, readable for persistence. |
| `proxy.baseUrl` | `string` | The proxy base URL — mutable, can be changed before calling `connect()`. |

```typescript
const proxy = new ProxyClient('https://backoffice.daquota.io/v1')
await proxy.connect('odoo', { url: 'https://myinstance.odoo.com', database: 'prod', login: 'admin', password: '...' })

// Save the token so the session survives a page reload
localStorage.setItem('proxy-token', proxy.token!)

// Restore on next load
const proxy = new ProxyClient('https://backoffice.daquota.io/v1', localStorage.getItem('proxy-token'))
await proxy.getSessionInfo()  // throws if expired — re-authenticate if needed
```

### PDF extraction

| Method | Returns | Description |
|--------|---------|-------------|
| `extractPdf(buffer, searchString?)` | `Promise<{ text, pageCount }>` | Extract text from a PDF via the proxy. Pass an optional `searchString` to receive only pages matching the query (plus one page of context either side). |

```typescript
const { text, pageCount } = await proxy.extractPdf(pdfBuffer)
```

### Encryption

| Method | Returns | Description |
|--------|---------|-------------|
| `isEncrypted(str)` | `boolean` | `true` if the string is in the proxy-encrypted format. |
| `encryptMessage(plainText)` | `Promise<string>` | Encrypt a string via the proxy. The result is safe to store and pass to the assistant. |
| `decryptMessage(cipherText)` | `Promise<string>` | Decrypt a proxy-encrypted string. |

> You rarely need to call these directly — `assistant.setLlmApiKey()` and `assistant.setApiUserKey()` handle encryption internally.

### CRM

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

## `LocalAssistant` API reference

### Constructor

```typescript
new LocalAssistant(config: LocalAssistantConfig)
```

```typescript
interface LocalAssistantConfig {
  proxy: ProxyClient       // authenticated proxy client (call proxy.connect() first)
  llm: LLMConfig           // LLM backend configuration
  darkMode?: boolean       // passed to the formula sandbox (default: false)
  apiPreferences?: ApiPreference[]    // previously persisted prefs (from 'prefs:change')
  resultContainer?: ResultContainer   // where to render formula results
  sandboxPermissions?: string[]       // iframe sandbox flags (see defaults below)
}

interface LLMConfig {
  type: 'gemini' | string  // backend type — only 'gemini' is implemented today
  apiKey?: string          // encrypted key restored from storage — set via setLlmApiKey()
  model?: string           // model ID (default: 'gemini-3-flash-preview')
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

### Configuration

| Property / Method | Type / Returns | Description |
|-------------------|----------------|-------------|
| `assistant.llm` | `LLMConfig` | Read or replace the LLM configuration. Emits `'llm:change'`. |
| `assistant.darkMode` | `boolean` | Toggle dark mode in the analysis sandbox. |
| `assistant.resultContainer` | `ResultContainer` | Where formula results are rendered. |
| `assistant.sandboxPermissions` | `string[]` | iframe sandbox flags. |
| `assistant.proxy` _(read-only)_ | `ProxyClient` | The proxy client passed at construction. |
| `setLlmApiKey(plainKey)` | `Promise<void>` | Encrypt a plain API key via the proxy and store it. Emits `'llm:change'`. |

---

### Datasets

Datasets are ordered key-value pairs: name → array of row objects (tabular) or PDF document (with extracted text). The **active dataset** is exposed as the `data` variable inside formula code; all datasets are accessible via `datasets['name']`.

| Method | Returns | Description |
|--------|---------|-------------|
| `addDataset(name, rows)` | `void` | Add or replace a tabular dataset. First added becomes active. |
| `addPdfDataset(name, buffer, extractedText, pageCount)` | `void` | Add a PDF document. Pass the text returned by `ProxyClient.extractPdf()`. |
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

### External APIs

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

### Conversation

| Method | Returns | Description |
|--------|---------|-------------|
| `prompt(message, opts?)` | `Promise<AssistantResponse>` | Send a user message. Builds system prompt, calls the LLM, appends to history, emits `'message'`. |
| `getHistory()` | `ConversationTurn[]` | Full conversation history. |
| `setHistory(turns)` | `void` | Replace the conversation history (e.g. to restore a session). |
| `appendHistory(turn)` | `void` | Append a single turn. |
| `clearHistory()` | `void` | Reset conversation to empty. |
| `getLastFormula()` | `string \| null` | Formula code from the most recent model response. |
| `buildCurrentSystemPrompt(example?)` | `string` | Build the system prompt for the current state without sending it. |

#### `prompt()` options

```typescript
await assistant.prompt('Break down revenue by region', {
  exampleAnalysis: {      // inject a catalog analysis as a system-prompt example
    formula: '...',
    title: 'Revenue by country (bar chart)',
    description: '...',
  },
})
```

#### `AssistantResponse` shape

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

#### `executeFormula(formula)`

Renders a formula in the configured `resultContainer`. Creates the sandboxed iframe, applies `sandboxPermissions`, wires up the proxy fetch relay, and emits `formula:done` / `formula:error`. Called automatically by `prompt()` when `resultContainer` is set.

```typescript
// Manual execution (e.g. replaying a catalog analysis)
assistant.executeFormula(savedAnalysis.formula)
```

#### `destroy()`

Removes the managed iframe and cleans up all event listeners. Call when the assistant is no longer needed.

```typescript
assistant.destroy()
```

---

### Analysis match hook

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

### Events

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
| `data:local` | `{ data: string, action: string }` | An action completed entirely in the browser. E.g. file loaded from disk, formula executed in sandbox. |
| `data:proxy` | `{ data: string, action: string }` | Data was sent to the proxy server but not to the LLM. E.g. PDF extraction. |
| `data:llm` | `{ data: string, action: string }` | Data was forwarded to the LLM. E.g. document text or column statistics in a conversation turn. |

---

## Running the demonstrator app

### Prerequisites

- Node.js 22+
- A running [LocalFlow proxy](https://github.com/localflow-fr) instance  
  (or use the hosted one at `https://backoffice.daquota.io/v1`)

### Environment

Create `localflow-app/.env.local` (git-ignored):

```bash
VITE_PROXY_URL=https://backoffice.daquota.io/v1
```

### Development

```bash
nvm use 22
npm install
npm run dev
```

Opens at `http://localhost:5173`.

### Production build

```bash
nvm use 22
npm install
npm run build   # output in dist/
```

> **Note:** The build includes a ~22 MB `.wasm` file from `@huggingface/transformers` (used for semantic catalog matching). It is fetched from the HuggingFace CDN at runtime and cached by the browser after the first visit.

### Deploying

The app is a static SPA — deploy the `dist/` folder to any static host.

**SCP example (current production setup):**

```bash
nvm use 22
npm install
npm run build
scp -P 52345 -r localflow-app/dist/* jsweet@public.jsweet.org:/var/www/DLITE_DATA/__apps/localflow
```

**Sub-path deployment** — if the app is not served at the domain root, set the base path before building:

```typescript
// vite.config.ts
export default defineConfig({
  base: '/localflow/',   // must match the server path
  ...
})
```

The current production instance is served at `https://apps.daquota.io/localflow/`.

---

## Project structure

This is an **npm workspaces monorepo** with two packages.

```
localflow/                    ← git root / workspace root
├── package.json              # workspace: ["localfirst-ai-lib", "localflow-app"]
├── README.md
│
├── localfirst-ai-lib/        # ── reusable library (publishable as npm package)
│   ├── package.json          # name: "localfirst-ai"
│   ├── tsconfig.json         # emits dist/ with .js + .d.ts
│   └── src/
│       ├── index.ts          # public exports
│       ├── LocalAssistant.ts # the core class
│       └── types.ts          # all public TypeScript interfaces
│
└── localflow-app/            # ── demonstrator React application
    ├── package.json          # depends on "localfirst-ai": "*" (workspace)
    ├── vite.config.ts        # Vite alias: 'localfirst-ai' → lib TS source (no pre-build needed)
    ├── index.html
    └── src/
        ├── App.tsx           # root: auth, tab management, orchestration
        ├── components/
        │   ├── AiAssistant.tsx     # conversation UI (React wrapper around LocalAssistant)
        │   ├── AnalysisPanel.tsx   # iframe result panel (with sandbox ShieldCheck indicator)
        │   ├── AnalysisCatalog.tsx # saved analyses sidebar (with sandbox ShieldCheck indicator)
        │   ├── ConfigPanel.tsx     # settings drawer
        │   ├── CrmPicker.tsx       # CRM data loader (Odoo / Salesforce)
        │   ├── DataFlowStatus.tsx  # data flow status chip + session history popover
        │   ├── DataTable.tsx       # tabular data viewer
        │   ├── DepsDialog.tsx      # analysis dependency inspector
        │   └── LoginScreen.tsx     # auth screen with configurable proxy URL
        ├── i18n/
        │   ├── en.json       # English strings
        │   └── fr.json       # French strings
        ├── hooks/
        │   └── useFileLoader.ts    # CSV / Excel / PDF drag-and-drop
        └── lib/
            ├── analysisCatalog.ts  # localStorage-backed analysis catalog
            ├── pdfExtractor.ts     # fallback local PDF extractor (PDF.js, unused when proxy available)
            ├── semanticSearch.ts   # HuggingFace Transformers.js embedding search
            ├── storage.ts          # proxyClient singleton + DEFAULT_PROXY_URL
            └── utils.ts
```

### Dev workflow

```bash
npm install          # installs both workspaces + creates the localfirst-ai symlink
npm run dev          # starts the Vite dev server for localflow-app
npm run build        # builds localfirst-ai-lib (tsc → dist/) then localflow-app (Vite)
```

The Vite alias `'localfirst-ai' → '../localfirst-ai-lib/src/index.ts'` means the dev server uses the library TypeScript source directly — no pre-build of the library is required during development. The standalone `tsc` build in `localfirst-ai-lib/` is only needed when publishing the library to npm.

---

## Roadmap highlights

- [ ] Publish `localfirst-ai-lib/` to npm as `localfirst-ai`
- [ ] Pluggable LLM backends (OpenAI, Anthropic, Mistral, Ollama)
- [ ] Interactive formula results (action buttons returned by formulas)
- [ ] Async / streaming formula execution

### Recently shipped

- [x] **PDF document support** — PDFs as first-class datasets; text extracted via the proxy, full document text injected into LLM context
- [x] **Data flow awareness** — `data:local` / `data:proxy` / `data:llm` events; animated status chip in the header; session history popover; sandbox safety indicator on all Run buttons
- [x] **Configurable proxy URL** — login screen lets users point to their own proxy instance; URL persisted in localStorage
- [x] **CRM connectors** — Odoo and Salesforce authentication and data loading via `ProxyClient`

---

## Contributing

Pull requests welcome. Please open an issue first for significant changes.

```bash
git clone https://github.com/localflow-fr/localflow
cd localflow
nvm use 22
npm install
npm run dev
```

Code style: TypeScript strict, no `any`, Tailwind for styles, no unnecessary comments.

---

## License

```
MIT License

Copyright (c) 2026 LocalFlow

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
