# LocalFlow Core — Local-first AI Library

> **Apache 2.0 License** — See [LICENSE](#license) at the bottom of this file.

---

## What is Local-first AI?

In its strict definition, local-first AI means running the AI model itself in the browser, making inference local so that your data never leaves your device. The appeal is real: no cloud dependency, no data sent to a third party, full privacy by default.

In practice, however, this approach faces significant limitations:

- **Model quality** — browser-based models are considerably weaker than cloud models, especially for complex tasks like code generation or structured reasoning. The gap is narrowing, but remains wide enough to matter for production use: a hallucination in a code generator produces a formula that silently computes the wrong result.
- **Scalability** — running a capable LLM locally demands a powerful, typically GPU-equipped device, raising the barrier for end users. Every query runs a full model pass on the user's device, which is rarely as energy-efficient as an optimised data centre — a green IT cost that is easy to overlook, and that compounds with usage.
- **External data access** — the strict vision focuses on where inference runs, but does not address how the AI can securely access external data sources (APIs, CRMs, ERPs). In practice, user queries often require outside services, and there is no built-in mechanism to do so in a controlled, auditable way.

**LocalFlow proposes a slightly "relaxed" vision of local-first AI to overcome these issues.** Rather than constraining *where inference happens*, it constrains *what data inference ever sees*. The LLM acts as a one-time, data-blind code generator — only structural metadata (column names, statistical samples, document layout) is sent to the model. The generated code then executes locally in a sandboxed environment, on your actual data, producing deterministic results.

This relaxation is principled: the sensitive asset is your data, not the model. As long as raw data never reaches the LLM, the privacy guarantee holds — regardless of whether inference runs in the cloud, on your own server, or in the browser. A self-hosted LLM achieves the same guarantees as the strict approach while remaining free to use the strongest model available. The two visions are fully compatible and can be combined.

| | Strict local-first AI | LocalFlow local-first AI |
|---|---|---|
| Raw data stays local | ✅ | ✅ |
| Computation executes locally | ✅ | ✅ |
| Uses best available models | ❌ | ✅ |
| Compatible with self-hosted LLMs | ✅ | ✅ |
| Results are deterministic | ❌ | ✅ |
| Re-runs without extra AI tokens | ❌ | ✅ |
| Works on large datasets | Limited | ✅ |

### The LLM as a one-time code generator

With LocalFlow's local-first AI, the LLM acts as a **code generator**, not a data processor. As little as possible is sent to make that generation work:

- **Structured data** (CSV, Excel, CRM): column headers and statistical samples are enough for the LLM to write correct analysis code. Raw rows are never sent.
- **Documents** (PDF): the extracted text is needed so the LLM understands the document's structure and can write a reliable parser. Users can work with obfuscated or template documents to generate formulas, then run them locally on real documents — the LLM only needs the structure, not the actual values.

### Transparent two-step process

Code generation (step 1) and local execution (step 2) are invisible to the user — the assistant behaves like a regular AI assistant. The difference is that **generated analyses can be saved and re-run** on any compatible dataset without making another LLM call.

### Key properties

1. **Full AI power** — use the best available LLM to analyse complex, heterogeneous data
2. **Data safety** — sensitive data stays local even when using a cloud LLM; a self-hosted LLM removes the last network hop entirely
3. **No hallucinated results** — outputs are computed from real data by deterministic code, not inferred by the model
4. **Scalable** — once generated, run the same analysis on large datasets as many times as needed, consuming no additional AI tokens
5. **Explainable** — the generated code is fully inspectable; any AI can explain why a formula works or debug why it fails
6. **Green and sustainable** — AI is used only for code generation, a one-time cost per analysis. Subsequent runs consume no AI inference at all, reducing dependence on energy-intensive infrastructure

> 📄 For a deeper dive into these concepts, read the [LocalFlow white paper](https://localflow.fr/LocalFlow%20-%20white%20paper%20-%20en.pdf).

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

Because the LLM only ever sees structural metadata — never the actual rows — there are tasks that LocalFlow's local-first approach cannot perform on its own. Inference excels at understanding natural language, translating free-form content, summarising documents, or spotting patterns across raw text. When those capabilities need to operate on the full dataset, a classical AI pipeline (one that sends the data to the model) remains the right tool.

LocalFlow is therefore a **complement to classical AI, not a replacement**. It opens up use cases that are out of reach for classical AI — large-scale data analysis without privacy exposure, deterministic and repeatable results, scalable execution at zero marginal AI cost — while leaving room for classical approaches where they are genuinely needed.

That boundary is not fixed. The proxy can expose tools — including LLM-powered ones — that operate on a carefully scoped subset of data, defined and controlled by the administrator or the user. A formula could, for example, call a proxy-hosted service that summarises a specific field or translates a column, without the LLM ever seeing the full dataset. This kind of extension requires intentional configuration of your proxy environment and its available tools, tailoring the setup to your specific use cases and acceptable data-sharing boundaries.

---

> **Want to see it in action?** Try the [LocalFlow online assistant](https://apps.daquota.io/localflow/) — no installation needed. Source: [localflow-app](https://github.com/localflow-ai/localflow-app).

## Quick start — embedding `LocalAssistant` in your app

### 1. Install

```bash
npm install localflow-core
```

> **Development (monorepo):** `localflow-app` references this package via `file:../localflow-core` and a Vite alias pointing directly to the TypeScript source — no pre-built `dist/` is required during development.

### 2. Set up the proxy

The assistant requires a [LocalFlow proxy](https://github.com/localflow-ai/localflow-proxy) instance. The proxy is the mandatory network gateway for the local-first AI sandbox — all outbound calls from formula execution pass through it. It handles:

- **Security and session management** — authenticates users against your business systems (CRM, ERP, or guest sessions), manages session tokens, and encrypts API keys so secrets are never exposed to the browser
- **API governance** — defines which external APIs formulas may call; supports BYOK, per-source throttling, URL whitelisting, and OAuth 2.0 token exchange
- **Server-side edge services** — PDF text extraction, OCR, and other tasks better suited to a server than a browser
- **LLM bridge** — decrypts the user's API key at request time and forwards generation requests to the LLM
- **Data flow monitoring** — tracks and audits what data enters and leaves the sandbox

**Quick testing:** a hosted instance is available at `https://backoffice.daquota.io/v1` — no account needed. You can start with a guest (public) session, or authenticate against your own CRM if you want to test with real data. That said, you probably don't want to point your production CRM at an instance you don't control; use a sandbox or test environment instead.

**Self-hosting:** for production use, run your own instance — see the [localflow-proxy](https://github.com/localflow-ai/localflow-proxy) repository for setup instructions.

### 3. Authenticate with the proxy

```typescript
import { ProxyClient } from 'localflow-core'

const proxy = new ProxyClient('https://backoffice.daquota.io/v1')

// Authenticate — stores the session token on the proxy instance
await proxy.connect('odoo', { url, database, login, password })
// or for a public/guest session:
await proxy.connect('public', {})
```

### 4. Instantiate and configure

```typescript
import { LocalAssistant, type ApiPreference, type LLMConfig } from 'localflow-core'

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
assistant.on('data:llm', (payload) => {
  // payload is LlmDataPayload — categorical data, no display strings
  // { kind: 'table'|'pdf'|'text', query, dataset, columns?, pages? }
  console.log('LLM event:', payload.kind, payload.dataset)
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
assistant.setAnalysisMatchHook(async (query, ctx) => {
  const analyses = catalogLoad()        // your catalog store
  return findBestMatch(query, analyses, ctx.activeColumns)
})
```

---

## `ProxyClient` API reference

```typescript
import { ProxyClient } from 'localflow-core'

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
| `data:local` | `{ data: string, action: string }` | An action completed entirely in the browser. E.g. file loaded from disk, formula executed in sandbox. Emitted by the app layer. |
| `data:proxy` | `{ data: string, action: string }` | Data was sent to the proxy server but not to the LLM. E.g. PDF extraction. Emitted by the app layer. |
| `data:llm` | `LlmDataPayload` | Data was forwarded to the LLM. Categorical payload — no display strings. `kind` is `'table'`, `'pdf'`, or `'text'`; always includes `query` (raw user message) and `dataset` (file/dataset name). Table events include `columns: number`; PDF events include `pages: number`. Import the type: `import type { LlmDataPayload } from 'localflow-core'`. |

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
├── package.json          # name: "localflow-core"
├── tsconfig.json         # emits dist/ with .js + .d.ts
└── src/
    ├── index.ts          # public exports
    ├── LocalAssistant.ts # the core class
    ├── ProxyClient.ts    # proxy client
    └── types.ts          # all public TypeScript interfaces
```

---

## Roadmap highlights

- [ ] Publish to npm as `localflow-core`
- [ ] Pluggable LLM backends (OpenAI, Anthropic, Mistral, Ollama)
- [ ] Interactive formula results (action buttons returned by formulas)
- [ ] Async / streaming formula execution

### Recently shipped

- [x] **PDF document support** — PDFs as first-class datasets; text extracted via the proxy, full document text injected into LLM context
- [x] **Data flow awareness** — `data:local` / `data:proxy` / `data:llm` events; animated status chip in the header; session history popover; sandbox safety indicator
- [x] **Configurable proxy URL** — proxy URL configurable at runtime; persisted in localStorage
- [x] **CRM connectors** — Odoo and Salesforce authentication and data loading via `ProxyClient`

---

## License

Apache 2.0 — see [LICENSE](LICENSE) for the full text.

Copyright (c) 2026 LocalFlow (localflow.fr)
