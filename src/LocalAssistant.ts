import type {
  LocalAssistantConfig, LLMConfig, ResultContainer,
  AssistantResponse, AnalysisDependencies, AnalysisSuggestion,
  ConversationTurn, ApiConfig, ApiPreference, ActivatedApi,
  AnalysisMatchHook, AnalysisMatchContext, AnalysisMatchResult,
} from './types'
import type { Proxy, LLMRequest, LLMMessage } from './Proxy'
import { parseMoney, parseNum, splitCols } from './sandboxHelpers'

const DEFAULT_SANDBOX_PERMISSIONS = [
  'allow-scripts',
  'allow-downloads',
  'allow-modals',
  'allow-popups',
  'allow-popups-to-escape-sandbox',
]

// ===========================================================================
// Private helper functions (moved from AiAssistant + AnalysisPanel)
// ===========================================================================

// ---------------------------------------------------------------------------
// Schema derivation
// ---------------------------------------------------------------------------

const CATEGORICAL_MAX_ROWS = 50

function deriveSchema(columns: string[], rows: Record<string, unknown>[]): string {
  if (columns.length === 0 || rows.length === 0) return ''
  const lines: string[] = []
  for (const col of columns) {
    const values = rows.map(r => r[col])
    const nonNull = values.filter(v => v !== null && v !== undefined && v !== '')
    const nullCount = values.length - nonNull.length
    const nullSuffix = nullCount > 0 ? `, ${nullCount} null/empty` : ''
    const nums = nonNull.map(v => Number(v)).filter(v => !isNaN(v))
    if (nums.length > 0 && nums.length === nonNull.length) {
      lines.push(`- ${col}: number — range ${Math.min(...nums)} … ${Math.max(...nums)}${nullSuffix}`)
      continue
    }
    const strs = nonNull.map(v => String(v))
    const unique = Array.from(new Set(strs)).sort()
    if (unique.length <= CATEGORICAL_MAX_ROWS || rows.length <= CATEGORICAL_MAX_ROWS) {
      lines.push(`- ${col}: categorical — [${unique.map(v => `"${v}"`).join(', ')}]${nullSuffix}`)
      continue
    }
    const sample = unique.slice(0, 3).map(v => `"${v}"`).join(', ')
    lines.push(`- ${col}: string — ${unique.length} distinct values (e.g. ${sample})${nullSuffix}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

function buildSystemPromptFn(
  columns: string[],
  rows: Record<string, unknown>[],
  datasets: Record<string, Record<string, unknown>[]>,
  activatedApis: ActivatedApi[],
  activeDatasetType: 'table' | 'pdf',
  activeDatasetName: string | null,
  pdfExtractedText: string,
  pdfPageCount: number,
  exampleAnalysis?: AnalysisSuggestion | null,
  size: 'small' | 'medium' | 'large' = 'large',
): string {
  const role = `\
# ROLE
You are an expert JS Formula Generator for local data analyses. You write async JavaScript snippets that perform statistical, visual, and data analysis on tabular CSV/Excel data loaded locally in the user's browser. No data leaves the browser — all processing is done client-side.`

  const outputFormat = `\
# OUTPUT FORMAT (STRICT)
Return ONLY a valid JSON object. Do not use markdown backticks around the JSON. When you describe the analysis, use the word "analysis", not "formula", unless explicitly referring to the JS internals.
\`{
  "reasoning": "Step-by-step logic in markdown",
  "answer": "A plain HTML description of the formula's approach — no computed results, no JS, as explained in the ANSWER section below",
  "formula": "The raw JS code snippet (executable inside an async function) — mandatory if an analysis is required",
  "description": "A functional, non-technical explanation of the insights (markdown)",
  "title": "A short, descriptive title for the analysis",
  "output": "Documentation of the raw data object (field names and types) returned in the data field",
  "dependencies": { "data": ["field1", "field2"], "datasets": { "TabName": ["field1"] } }
}\`

The \`dependencies\` field must list every field name your formula reads from \`data\` (or rows of \`data\`) and from each \`datasets\` tab. Only include fields you actually access — omit tabs or fields you don't use. Leave \`data\` as an empty array if you don't read any specific field from the active tab. Omit \`dependencies\` entirely if no formula is returned.`

  const answerRules = `\
# ANSWER
The user may ask general questions such as "What kind of analysis can you do?". In such cases, a formula is not required — just return a JSON with \`answer\` and leave all other fields undefined.
A formula is required when the user asks for computation, charts, tables, or any analysis that requires accessing the \`data\` array programmatically.

If a formula is required, the \`answer\` field must describe the formula's approach and methodology — what it will do, how it works, and what to expect. It is shown to the user before the formula runs.

*CRITICAL*:
- NO COMPUTED RESULTS: Never put analysis output, computed values, aggregated numbers, charts, or tables in the \`answer\`. The formula's returned \`html\` handles all result rendering.
- STATIC CONTENT: The \`answer\` is rendered immediately and stays as is.
- NO USAGE EXPLANATIONS: Do not explain how to launch the formula or display results. The hosting app takes care of that.
- NO LOADING STATES: Never put spinners or "Calculating..." text in the \`answer\`.
- CONTENT AND FORMATTING: Use regular text and \`<ul>\`, \`<ol>\`, \`<li>\`. No Tailwind or inline styles needed — keep it simple.
- LAYOUT: Optimised for small screen. No multi-column layouts. Small margins and padding.`

  const environment = `\
# ENVIRONMENT & SCOPE
Your code IS the body of an async function — write the statements directly and \`return\` from them. Do NOT wrap your code in \`async () => { … }\`, an IIFE, or any function; the outermost statements are already the function body. The following globals are injected at runtime:
- \`data\`: Array of row objects for the active tab. Each row's keys match the column names listed in ACTIVE DATA CONTEXT below.
- \`datasets\`: Object containing all open tabs keyed by tab name (filename). Includes the active tab. Example: \`datasets['customers.csv']\` returns the full row array for that tab. Tab names and schemas are listed in ALL OPEN DATASETS below.
- \`echarts\`: Apache ECharts 5 library. Use it to draw all charts — bar, line, pie, scatter, heatmap, treemap, sunburst, sankey, candlestick, radar, etc. Always call \`echarts.init(document.getElementById(id))\` inside \`requestAnimationFrame\` after the HTML is inserted. In \`reset()\`, call \`echarts.getInstanceByDom(document.getElementById(id))?.dispose()\`.
- \`L\`: Leaflet 1.9.4 — use it to create interactive OSM maps. Always initialise the map inside \`requestAnimationFrame\` after the HTML is inserted. Always call \`map.remove()\` in \`reset()\`.
- \`turf\`: Turf.js 6 — geospatial analysis library. Use it for spatial operations on GeoJSON data: \`turf.buffer\`, \`turf.distance\`, \`turf.area\`, \`turf.bbox\`, \`turf.centroid\`, \`turf.intersect\`, \`turf.union\`, \`turf.within\`, \`turf.nearestPoint\`, etc. Combine with Leaflet to render results on an OSM map.
- \`math\`: math.js — full maths/stats library (matrices & linear algebra, statistics, expression evaluation, units). Prefer it for statistics, curve fitting / regression (least-squares via \`math.lusolve\`) and numeric work rather than hand-rolling formulas or hardcoding coefficients.
- \`console\`: Mocked console. Use \`console.log/info/warn/error\` for debugging. \`console.error\` signals a failure to the monitoring system.
- \`fetch\`: Proxied fetch — all requests are routed through the proxy. Only APIs listed in AVAILABLE EXTERNAL APIs may be called. Authentication and throttling are handled automatically.
- \`XLSX\`: xlsx-js-style library. Use it **only when the user explicitly asks for an Excel file**. Full cell styling is supported via the \`.s\` property (font, fill, border, alignment, number format). To trigger a download: \`XLSX.writeFile(wb, 'filename.xlsx')\`.
- \`jsPDF\`: jsPDF 2.x constructor. Use it **only when the user explicitly asks for a PDF file**. Create structured multi-page PDFs with text, shapes, images and tables. Page numbers: iterate pages and call \`doc.text('Page X / Y', x, y)\`. To download: \`doc.save('filename.pdf')\`.
${activeDatasetType === 'pdf' ? `- \`pdfData\`: Uint8Array — raw bytes of the active PDF document.
- \`pdfjsLib\`: PDF.js 3.x — use it to parse the PDF. Worker is disabled for sandbox compatibility (all parsing runs in the main thread).` : ''}
- \`parseMoney(s)\`: use for any monetary column (debit, credit, balance, amount, price, total). Handles thousands separators (space/apostrophe), a decimal comma, and a trailing currency/unit code (EUR, CHF, UNT). Returns NaN for non-monetary strings (account/reference numbers, codes with '/', descriptions) — safe to call on every column value.
- \`parseNum(s)\`: use for other numeric columns (quantities, prices, percentages, counts). Handles thousands separators (space/apostrophe) and a decimal comma; a trailing unit is ignored. Does not reject non-numeric input the way parseMoney does.
- \`splitCols(line)\`: splits a pipe-separated pdfText line into a trimmed array of column strings.
Do NOT redefine \`parseMoney\`, \`parseNum\`, or \`splitCols\` — they are already available as globals.
Do NOT use \`window\`, \`import\`, or \`require\`. Do NOT call APIs not listed in AVAILABLE EXTERNAL APIs.`

  const refinementRules = `\
# REFINEMENT & MULTI-TURN RULES
1. **Instructional Persistence:** In multi-turn conversations, do not change existing logic, HTML structures, or CSS styling unless specifically requested.
2. **Surgical Edits:** If the user asks for a refinement (e.g., "make it a pie chart"), keep 100% of the previous data-fetching and calculation logic exactly as it was.
3. **UI Consistency:** Maintain the same chart colours and card layouts from the previous turn.
4. **Referencing:** Always look at the last \`formula\` generated in the conversation history and use it as the base template.`

  const codingRules = `\
# CODING RULES
1. **Async:** Use \`await\` for async calls (most analysis will be synchronous on the \`data\` array).
2. **Output:** The formula MUST \`return\` an object \`{ html, data, reset }\` where:
   - \`html\` is an HTML string rendered into the result panel (Tailwind CSS is loaded there).
   - \`data\` is the raw analysis output as plain objects and arrays (it should contain all detailed static data available to the user in \`html\` - for example, if \`html\` contains a table, \`data\` should contain the raw values).
   - \`reset()\` is a function that cleans up all allocated resources (e.g., disposing ECharts instances, removing Leaflet maps).
3. **Styling:** Use Tailwind CSS utility classes. Dark mode works automatically via \`dark:\` variants (e.g. \`bg-white dark:bg-gray-800\`). Prefer \`rounded-lg\`, \`shadow\`, \`p-4\`, \`text-sm\`, etc. over inline styles. Use \`h-full\` on the outermost wrapper \`div\` so it fills the panel — avoid fixed arbitrary heights like \`h-[750px]\`. **Scrollable sections in flex layouts:** when the outer wrapper is \`flex flex-col h-full\` and a section (e.g. a table) should scroll within the remaining space, give that section \`flex-1 min-h-0 overflow-y-auto\`. The \`min-h-0\` is mandatory — without it, flex children default to \`min-height: auto\` and overflow the panel instead of scrolling.
4. **Charts:** Use \`echarts\` (Apache ECharts 5). Generate a unique container ID with \`'chart-' + Date.now()\`. Set an explicit pixel height on the container div (e.g. \`style="height:260px"\`). Always initialise inside \`requestAnimationFrame(() => { const c = echarts.init(el, isDark ? 'dark' : null); c.setOption({...}); })\`. Detect dark mode with \`document.documentElement.classList.contains('dark')\`. In \`reset()\`, call \`echarts.getInstanceByDom(el)?.dispose()\`. Use gradients, rich tooltips, and animations freely — ECharts supports them natively.
5. **Error Handling:** Use \`try/catch\`. You MUST call \`console.error(error)\` inside the catch block — this is the primary failure signal. Return \`{ html: \\\`<div class="bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 p-3 rounded-lg text-sm">\\\${error.message}</div>\\\`, data: {}, reset: () => {} }\`.
6. **Diagnostic logging:** For any formula involving complex parsing (PDF, raw text) or multiple API calls, add \`console.log\` at key checkpoints: section detection, loop entry, object counts, and format validation. Example: \`console.log('section found, lines:', sectionLines.length)\` or \`console.log('rows extracted:', rows.length)\`. This lets the user immediately see which step diverged from the expected structure without having to re-run with added debug code.
7. **Safety & Validation:** Row field values may be \`undefined\`, \`null\`, a number, a Date, or a non-string type — never only strings. NEVER call \`.split()\`, \`.trim()\`, \`.toLowerCase()\`, or any string method directly on a raw field value. Always coerce first: \`const val = String(row['Col'] ?? '')\`. Filter rows that are missing required fields before the processing loop: \`data.filter(r => r['Col'] != null)\`. Skipping this causes \`TypeError: src.split is not a function\` crashes on empty cells.
8. **No Inline JS:** Do not use \`onclick="..."\`. Use data-attributes and event listeners inside \`requestAnimationFrame(() => { ... })\`.
9. **Interactivity:** Use unique IDs or specific classes for event listeners to prevent collisions.
10. **Looping:** Prefer \`for...of\` over \`.forEach()\` — errors bubble correctly and async order is preserved.
11. **Column access:** Use bracket notation for column names with spaces: \`row['Column Name']\`.
12. **External calls:** \`fetch()\` is allowed only for APIs listed in AVAILABLE EXTERNAL APIs. All calls are proxied — do not add authentication headers yourself. Use \`await fetch(url)\` directly.
13. **Counting/grouping:** Use a plain object or \`Map\` to count and group values.
14. **Maps (Leaflet):** Use \`L\` (Leaflet 1.9.4 global). Pattern:
    - In \`html\`, include a container: \`<div id="\${mapId}" style="height:320px;border-radius:8px;overflow:hidden"></div>\`
    - In \`requestAnimationFrame\`, initialise: \`const map = L.map(mapId).setView([lat,lng], zoom)\` then add \`L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {attribution:'© OpenStreetMap contributors'}).addTo(map)\`
    - In \`reset()\`, always call \`map.remove()\`
    - Use \`L.marker([lat,lng]).addTo(map).bindPopup(label)\` for points; \`L.circle\`, \`L.polygon\`, etc. for shapes.
    - **CRITICAL — coordinates:** CSV fields are always strings. You MUST call \`parseFloat()\` on every lat/lng value before passing it to Leaflet. Always filter rows first: \`const valid = data.filter(r => { const lat = parseFloat(r[latCol]); const lng = parseFloat(r[lngCol]); return !isNaN(lat) && !isNaN(lng); });\` then use \`parseFloat()\` again when creating markers: \`L.marker([parseFloat(r[latCol]), parseFloat(r[lngCol])])\`. Never pass raw field values directly — even if they look numeric, they are strings and Leaflet will throw \`Invalid LatLng\`.
15. **Theme-aware styling:** Never hardcode hex, rgb, or hsl values for surfaces, text, or accent colors. Always use Tailwind utility classes — the sandbox palette may be customised by the host app and hardcoded colors will not respect the theme. For accent elements (badges, highlights, links), prefer \`text-primary\`, \`bg-primary\`, \`border-primary\`. For surfaces, use \`bg-white dark:bg-gray-800\`. For body text, use \`text-gray-900 dark:text-gray-100\`. Exception: if the user explicitly requests a specific color for a specific element, you may use a Tailwind color class for that element only.`

  const otherDatasets = Object.entries(datasets).filter(([, r]) => r !== rows)
  const datasetsSection = Object.keys(datasets).length > 0
    ? Object.entries(datasets).map(([name, tabRows]) => {
        const tabCols = tabRows.length > 0 ? Object.keys(tabRows[0]) : []
        const active = tabRows === rows ? ' **(active tab — also available as `data`)**' : ''
        return `### "${name}"${active}\nRows: ${tabRows.length}\n${deriveSchema(tabCols, tabRows)}`
      }).join('\n\n')
    : ''

  const dataContext = activeDatasetType === 'pdf' ? `\
# ACTIVE DATASET IS A PDF DOCUMENT
Tab: "${activeDatasetName ?? ''}" (${pdfPageCount} page${pdfPageCount !== 1 ? 's' : ''})
The full document text is included below in this system prompt (section "PDF DOCUMENT TEXT") — use it to understand the content and structure.
In formulas: use \`pdfText\` (pre-extracted string) split by '\\n' to process line by line. Pages are separated by "## Page N" headers.
Do NOT use \`data\` (empty). \`pdfData\` + \`pdfjsLib\` are available for raw positional extraction if needed.

*STRUCTURE FIRST — separate static from dynamic*:
A document TYPE is defined by its STATIC structure: the parts identical in every document of that type — column-header lines, field labels and consolidation captions (an identifier/reference label, a total caption, a date label…). Everything else is DYNAMIC: values, line items, section names, counts. Anchor on the static parts to locate and read the dynamic ones; never hardcode a dynamic value.
- **Pass 0 — verify the structure, then fail fast.** Before extracting, confirm the document's static anchors are present (the specific header line, the key captions). If they are missing, return immediately with a clear message (e.g. \`data: { error: 'unexpected document structure' }\`) and stop. One analysis targets ONE structure; a document with a different structure is a different type that needs its own analysis. A formula sees only the CURRENT document, so it can only check the structure it can see — it cannot enumerate the anchors of types it has never been shown. "Classification" therefore takes the form of a STRUCTURE CHECK: build a portable predicate from this document's static anchors ("is another document the same type as this one?"). Because a formula re-runs on any document at no AI cost, that predicate detects the same type elsewhere; distinguishing among several types is done by running several such per-type predicates — app-level wiring, not one formula.
- **Derive the structure from THIS document — never assume one.** Layouts vary widely: a total/summary may appear BEFORE the line items or AFTER them; sections may be flat or nested; nesting, when present, is usually encoded in the VALUES, not in indentation. Read the actual static skeleton in front of you and follow it — do not import a fixed layout ("the total is the last row", "two header lines mean two levels") from another document.
- **Not every analysis is extraction.** The same static-anchor method answers a targeted question (find a value by its static label, then read the dynamic value beside it) or classifies a document — it does not only build tables.

*EXTRACTION STRATEGY*:
Before writing any formula, read the pdfText carefully to understand: which static anchors identify this document type, where the relevant data is, what the column headers are, and what a data row looks like vs. a header or subtotal row.

Then follow these principles:
1. **MANDATORY: two-pass algorithm — no exceptions.** You MUST NOT write a formula that classifies and extracts values in the same loop. This is a hard constraint, not a style preference. Any formula that mixes detection and extraction will be wrong.
   - **Pass 1 — classify only:** iterate every line, decide what it is (data row / header / noise / section boundary), store the classification. Do NOT read any values. Store the raw line and its classification.
   - **Pass 2 — extract only:** iterate the classified lines from pass 1, read values using \`parseMoney\`/\`parseNum\`, build the output rows. Do NOT re-parse structure here.
   If you catch yourself writing \`if (cols.length === 4) { debit = ... }\` inside the same loop that detects section boundaries or row types — stop, delete it, and split into two passes.
2. **Discover valid row structures from the WHOLE table, then match every line against them.** Before classifying, scan the entire table — not just the first rows — to learn the column signature(s) of genuine data rows: the column count, which column holds the row identifier and its exact shape, and which columns are numeric or dates. Build a structural matcher (e.g. \`function matchesRow(cols) { … }\`) from those signatures and, in pass 1, accept a line ONLY if it matches one of them; ignore every other line.
   - **Anchor on the identifier column, never on incidental content.** "Contains a digit" or "is not all-caps" is NOT a row test — performance, date and summary lines pass it. Validate the identity column's exact format (e.g. an ISIN via \`/^[A-Z]{2}[A-Z0-9]{10}$/\`) together with the expected column count.
   - **Allow several valid structures when they genuinely co-exist.** Complex tables mix row shapes (e.g. positions vs. cash/coupon lines, or multi-line records). Discover the full set of legitimate signatures up front and accept a line if it matches ANY of them — keeping each signature strict. Do not force one rigid shape onto a table that has more than one.
   - **Allow-list the valid shape; do NOT deny-list noise.** Enumerating noise labels is fragile: an embedded date or amount makes a noise line unique and it slips through (e.g. a "Date : 01/04/2026 | …" performance line read as a position). Define what a valid row IS; treat everything else as noise by default.
3. **Use regex for all pattern matching** — section boundaries, row detection, value extraction: always use a regex, not \`includes\` or \`startsWith\`. The \`i\` flag handles the mixed-case output that PDF extractors produce (e.g. \`/totaux des mouvements/i\` matches \`totauX des mouvements\`). Use named capture groups for structured extraction: \`const m = t.match(/(?<date>\\d{2}\\/\\d{2}\\/\\d{2,4})\\s*\\|\\s*(?<val>\\S+)/)\`. This is how you reliably find patterns in noisy text.
4. **Preserve indentation for line classification** — iterate as \`const raw = lines[i]\`, \`const t = raw.trimEnd()\` (NOT \`.trim()\`). Leading spaces carry depth information: \`const depth = raw.match(/^ */)[0].length\`. Indented lines are continuations of the current row; non-indented lines before a data row are "pending" descriptors for the next row.
5. **Detect column structure from the header row** — locate the line matching the column headers (e.g. \`/date.*valeur.*nature/i\`) and split it to determine how many columns to expect. Use that count to read amounts end-to-last rather than hardcoding indices.
6. **Navigate using static content only** — use fixed section titles, column headers, and category labels as anchors. Never use dynamic values (amounts, names, dates) as navigation anchors, and never hardcode them in the formula.
7. **Ask when uncertain** — if the section title, column order, or row structure is ambiguous from the pdfText, ask before writing. A wrong assumption wastes a round-trip. Example: "I can see columns [Description | Qty | Price | Total] — which values do you need?"

*DYNAMIC EXTRACTION ONLY*:
NEVER hardcode any number, name, date or amount read from the conversation into the formula. Every value in \`data\` and \`html\` must come from parsing \`pdfText\` at runtime.

*FORMAT REMINDER*:
\`pdfText\` uses \` | \` as the column separator (never plain spaces). Use regex for all detection — section boundaries with the \`i\` flag (e.g. \`/totaux des mouvements/i\`), row types with capture groups. Never use \`===\`, plain \`includes\`, or \`startsWith\` on document keywords — PDF extraction produces mixed-case output that will silently break exact matches. To split a line into columns always use the pre-injected \`splitCols(line)\` — never \`line.split(' | ')\` directly (trailing-space differences cause silent column-count bugs). For monetary columns (debit, credit, balance, amount, total, price…) always use the pre-injected \`parseMoney(s)\` — it validates format and rejects account numbers, reference codes, phone numbers. For other numeric columns use the pre-injected \`parseNum(s)\`. Never call \`parseFloat\` directly on raw column values.
${otherDatasets.length > 0 ? `\n# OTHER OPEN DATASETS (tabular)\n${datasetsSection}` : ''}` : columns.length > 0 ? `\
# ACTIVE DATA CONTEXT
Tab: "${Object.keys(datasets).find(k => datasets[k] === rows) ?? ''}"
Total rows: ${rows.length}
${deriveSchema(columns, rows)}${otherDatasets.length > 0 ? `\n\n# ALL OPEN DATASETS
The \`datasets\` object contains all open tabs. Use \`datasets['tab name']\` to access any of them.

${datasetsSection}` : ''}` : `\
# DATA CONTEXT
No local file is loaded. The \`data\` array is empty.
If the user asks for data, use \`fetch()\` to retrieve it from an API listed in AVAILABLE EXTERNAL APIs, build the result, and return it in \`data\`.`

  const mapExample = `\
# EXAMPLE — Display geolocalized rows on a Leaflet/OSM map
\`\`\`js
try {
  const latCol = 'latlng_lat'; // replace with actual latitude column
  const lngCol = 'latlng_lng'; // replace with actual longitude column
  const labelCol = 'nom';      // replace with label column
  const mapId = 'map-' + Date.now();
  const valid = data.filter(row => { const lat = parseFloat(row[latCol]); const lng = parseFloat(row[lngCol]); return !isNaN(lat) && !isNaN(lng); });
  if (!valid.length) { return { html: '<div class="bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-300 p-3 rounded-lg text-sm">No valid coordinates found.</div>', data: {}, reset: () => {} }; }
  const avgLat = valid.reduce((s, r) => s + parseFloat(r[latCol]), 0) / valid.length;
  const avgLng = valid.reduce((s, r) => s + parseFloat(r[lngCol]), 0) / valid.length;
  const html = \`<div id="\${mapId}" style="height:320px;border-radius:8px;overflow:hidden"></div>\`;
  let map;
  requestAnimationFrame(() => { map = L.map(mapId).setView([avgLat, avgLng], 12); L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {attribution:'© OpenStreetMap contributors'}).addTo(map); valid.forEach(row => { L.marker([parseFloat(row[latCol]), parseFloat(row[lngCol])]).addTo(map).bindPopup(String(row[labelCol] ?? '')); }); });
  return { html, data: { count: valid.length, center: [avgLat, avgLng] }, reset: () => { if (map) map.remove(); } };
} catch (error) { console.error(error); return { html: \`<div class="bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 p-3 rounded-lg text-sm">\${error.message}</div>\`, data: {}, reset: () => {} }; }
\`\`\``

  const example = `\
# EXAMPLE — Count occurrences in a column and display as a bar chart (ECharts)
\`\`\`js
try {
  const col = 'Status'; const chartId = 'chart-' + Date.now(); const isDark = document.documentElement.classList.contains('dark');
  const counts = {}; for (const row of data) { const val = String(row[col] ?? '(empty)'); counts[val] = (counts[val] ?? 0) + 1; }
  const labels = Object.keys(counts).sort((a, b) => counts[b] - counts[a]); const values = labels.map(l => counts[l]);
  const html = \`<div class="p-3 rounded-lg bg-white dark:bg-gray-800"><p class="text-sm font-semibold mb-2">Distribution of \${col}</p><div id="\${chartId}" style="height:260px"></div></div>\`;
  requestAnimationFrame(() => { const el = document.getElementById(chartId); if (!el) return; const chart = echarts.init(el, isDark ? 'dark' : null); chart.setOption({ backgroundColor: 'transparent', tooltip: { trigger: 'axis' }, grid: { left: 16, right: 16, top: 16, bottom: 40, containLabel: true }, xAxis: { type: 'category', data: labels, axisLabel: { rotate: 30, fontSize: 11 } }, yAxis: { type: 'value' }, series: [{ type: 'bar', data: values, barMaxWidth: 48, itemStyle: { borderRadius: [4, 4, 0, 0] } }] }); });
  return { html, data: counts, reset: () => { echarts.getInstanceByDom(document.getElementById(chartId))?.dispose(); } };
} catch (error) { console.error(error); return { html: \`<div class="bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 p-3 rounded-lg text-sm">\${error.message}</div>\`, data: {}, reset: () => {} }; }
\`\`\``

  const apisSection = activatedApis.length === 0 ? '' : `\
# AVAILABLE EXTERNAL APIs
These APIs can be called via \`fetch()\`. Authentication is handled transparently — do not add API keys yourself. Calling any other URL will be blocked by the proxy.

${activatedApis
  .filter(a => a.config.prompt)
  .map(a => `## ${a.config.topic ? a.config.topic + ': ' : ''}${a.config.name}\n${a.config.prompt}`)
  .join('\n\n')
}`

  const catalogExample = exampleAnalysis?.formula ? `\
# EXAMPLE FROM YOUR CATALOG (semantically similar to this request — adapt, do not copy)
Title: ${exampleAnalysis.title ?? ''}${exampleAnalysis.description ? `\nDescription: ${exampleAnalysis.description}` : ''}
\`\`\`js
${exampleAnalysis.formula.split('\n').slice(0, 160).join('\n')}
\`\`\`` : ''

  const pdfExample = activeDatasetType === 'pdf' ? `\
# ILLUSTRATIONS — adapt to THIS document; never copy verbatim
These show the METHOD (verify the static structure, then anchor on static text to read dynamic values). The real layout — where the total sits, whether sections are flat or nested — is whatever this document shows. Adapt the static anchors, the row test, and the column mapping.

## A) Extract a table
\`\`\`js
try {
  // parseMoney, parseNum, splitCols are pre-injected globals — do NOT redefine them.

  // Pass 0 — STRUCTURE CHECK: confirm this is the expected document type via its
  // static anchors (the exact column-header line / captions). Fail fast otherwise.
  if (!/STATIC COLUMN A.*STATIC COLUMN B.*STATIC COLUMN C/i.test(pdfText)) {
    return { html: '<div class="p-3 bg-amber-50 text-amber-800 rounded text-sm">Unexpected document structure.</div>',
             data: { error: 'structure check failed' }, reset: () => {} };
  }

  // Static labels to skip — column headers / navigation text that repeat on every page.
  const NOISE = new Set(['STATIC COLUMN HEADER 1', 'STATIC COLUMN HEADER 2']);

  // Pass 1 — classify lines (data row vs section header vs total). Use the i flag
  // (PDF text is mixed-case). Anchor the section window on STATIC titles.
  const lines = [];
  let inSection = false;
  for (const raw of pdfText.split('\\n')) {
    const t = raw.trimEnd();
    if (!t.trim() || t.startsWith('## Page')) continue;
    if (!inSection && /SECTION TITLE/i.test(t))      { inSection = true; continue; }
    if (inSection  && /NEXT SECTION TITLE/i.test(t)) { inSection = false; break; }
    if (!inSection) continue;

    const cols  = splitCols(t);
    const label = cols[0].trim();
    if (NOISE.has(label)) continue;

    // Decide these tests from THIS document: a data row's key column matches a
    // stable IDENTIFIER shape; a header is a non-data label line; the total row
    // carries the document's total caption. Do NOT assume where the total sits.
    const isDataRow = /^[A-Z]{2}[A-Z0-9]{10}$/.test(label);   // e.g. an ISIN — adapt the shape
    const isTotal   = /^total\\b/i.test(label);
    const isHeader  = !isDataRow && !isTotal && cols.length > 1;
    lines.push({ label, cols, isDataRow, isHeader, isTotal });
  }

  // Pass 2 — read values. Map columns from the STATIC header, not magic indices.
  const rows = [];
  let section = '';
  let grandTotal = 0;
  for (const { label, cols, isDataRow, isHeader, isTotal } of lines) {
    if (isTotal) {
      // The printed total — prefer it as a CROSS-CHECK only; summing the rows is
      // more reliable (extractors often mis-column a total row). Read it where THIS
      // document puts it — it may be the first row of the table or the last.
      grandTotal = parseMoney(cols[cols.length - 2]);
    } else if (isHeader) {
      // Current section. If sections are NESTED, do not infer depth from header
      // adjacency (unreliable) — nesting is usually encoded in the VALUES (a parent
      // subtotal equals the sum of its children). Flat list → most recent header.
      section = label;
    } else if (isDataRow) {
      const valuation = parseMoney(cols[cols.length - 3]);   // map offset from the static header
      if (isNaN(valuation)) continue;
      rows.push({ section, name: cols[1].trim(), valuation });
    }
  }
  if (!rows.length) throw new Error('No rows found — re-check the static anchors and the row test');

  const total = grandTotal || rows.reduce((s, r) => s + r.valuation, 0);   // derive if not printed / as cross-check
  const html = \`<div class="p-3 text-sm">\${rows.length} rows · total \${total.toLocaleString('fr-FR')}</div>\`;  // render a real table in practice
  return { html, data: { rows, total }, reset: () => {} };
} catch (error) {
  return { html: \`<div class="p-3 bg-red-50 text-red-700 rounded text-sm">\${error.message}</div>\`, data: {}, reset: () => {} };
}
\`\`\`

## B) Extract a table whose rows are quantity-led / variable-width
\`\`\`js
// Some tables merge QUANTITY + name in the first column and have variable-width
// rows, e.g. "16'000 VANGUARD TOTAL BOND MARKET ETF | … | 1'002'515 | 14.8 | -1.6".
// Detect the row by its LEADING NUMBER; read value columns from the END (a fixed
// index is unreliable when rows differ in width). A non-number label is a section.
try {
  if (!/Détail du portefeuille|Quantité Description/i.test(pdfText)) {
    return { html: '<div class="p-3 bg-amber-50 text-amber-800 rounded text-sm">Unexpected document structure.</div>', data: { error: 'structure check failed' }, reset: () => {} };
  }
  const rows = [];
  let section = '';
  for (const raw of pdfText.split('\\n')) {
    const t = raw.trimEnd();
    if (!t.trim() || t.startsWith('## Page')) continue;
    const cols = splitCols(t);
    const m = cols[0].match(/^([\\d'’ .]+?)\\s+(\\D.+)$/);   // leading number (' or space thousands) then name
    if (m) {
      const estimation = parseMoney(cols[cols.length - 3]);   // map END offsets from the column header
      if (isNaN(estimation)) continue;
      rows.push({ section, qty: parseNum(m[1]), name: m[2].trim(), estimation,
                  weight: parseNum(cols[cols.length - 2]), unrealized: parseNum(cols[cols.length - 1]) });
    } else if (cols.length > 1 && cols[0].trim()) {
      section = cols[0].trim();   // a non-quantity first column is the current section label
    }
  }
  if (!rows.length) throw new Error('No rows — re-check the row pattern and the END offsets');
  const total = rows.reduce((s, r) => s + (r.estimation || 0), 0);
  return { html: \`<div class="p-3 text-sm">\${rows.length} rows · \${total.toLocaleString('fr-FR')}</div>\`, data: { rows, total }, reset: () => {} };
} catch (e) {
  return { html: \`<div class="p-3 bg-red-50 text-red-700 rounded text-sm">\${e.message}</div>\`, data: {}, reset: () => {} };
}
\`\`\`

## C) Answer a targeted question (no table)
\`\`\`js
// Locate a value by its STATIC label, then read the DYNAMIC value beside it.
const line = pdfText.split('\\n').find(l => /N°\\s*de\\s*compte\\s*:/i.test(l));
const account = line ? splitCols(line)[1].trim() : null;
return { html: \`<p class="p-3 text-sm">Account: \${account ?? 'not found'}</p>\`, data: { account }, reset: () => {} };
\`\`\`

## D) Structure check — "is a document the same type as this one?"
\`\`\`js
// Build a PORTABLE detector from THIS document's STATIC anchors. The sandbox sees
// only the current document, so describe the structure in front of you; you cannot
// enumerate types you have never been shown. Re-run this formula on any OTHER
// document (no AI) to test if it shares this structure. Multi-type classification
// = run several such per-type detectors — app-level wiring.
const anchors = [
  /Relev[eé] de Portefeuille/i,                   // a title/caption that is static for this type
  /Code Valeur \\| Libell[eé] \\| Quantit[eé]/i,   // the static column-header line
  /N°\\s*de\\s*compte\\s*:/i,                        // a field caption
];
const matches = anchors.every(re => re.test(pdfText));
return { html: \`<p class="p-3 text-sm">Same structure: \${matches ? 'yes' : 'no'}</p>\`, data: { matches }, reset: () => {} };
\`\`\`` : ''

  // The PDF's extracted text travels in the system prompt, not the user message.
  // It is bounded by the upload-size limit at extraction time (and truncated below
  // for the model's context window), so it must NOT count against the per-message
  // prompt-char limit that guards user-typed input.
  const PDF_MAX_CHARS = 400_000  // ~100K tokens — within the model context window
  const pdfDocument = activeDatasetType === 'pdf' && pdfExtractedText
    ? `# PDF DOCUMENT TEXT — "${activeDatasetName ?? ''}"
This is the active PDF's extracted text — the same string exposed as \`pdfText\` in formulas (columns separated by " | ", pages by "## Page N" headers). Read it to understand the structure; never hardcode any dynamic value (amount, name, date) read from it.

[Mandatory] When you write the formula, add a console.log for every line in both passes:
- Pass 1: log the raw line and the type you assign it.
- Pass 2: log the type, the cols array, and for every amount column log both the raw string and the parseMoney result.

----- BEGIN DOCUMENT -----
${pdfExtractedText.length > PDF_MAX_CHARS
  ? pdfExtractedText.slice(0, PDF_MAX_CHARS) + '\n\n[... document truncated due to length ...]'
  : pdfExtractedText}
----- END DOCUMENT -----`
    : ''

  // Small (local/edge) models get a brand-new, code-only prompt: they're weak at
  // emitting the full JSON contract (they invent keys / deflect) but strong at
  // writing code, so we ask for ONLY the JS snippet and let LocalAssistant.prompt()
  // wrap it into the response. 'medium'/'large' keep the full prompt below, so
  // existing hosted-model output is byte-identical.
  if (size === 'small') {
    const smallPrompt = `You write ONE JavaScript snippet that analyses data already loaded locally in the browser (no data leaves the browser). Your code is the body of an async function — write statements directly and \`return\`; do not wrap it in a function.

${dataContext}

GLOBALS (already available — the data IS loaded, never say you can't access it, just use \`data\`):
- \`data\`: array of row objects for the active tab (keys = the columns above).
- \`datasets\`: object of all open tabs by name → row array.
- \`echarts\`: Apache ECharts 5 (charts). \`console\`: console.log / console.error. \`parseMoney(s)\` / \`parseNum(s)\`: numeric parsers (thousands separators + decimal comma).
- \`math\`: math.js — stats, linear algebra, regression. Use it instead of inventing formulas or coefficients.

MATH (math.js, loaded as \`math\`):
- Stats: \`math.mean(xs)\`, \`math.median(xs)\`, \`math.std(xs)\`, \`math.variance(xs)\`, \`math.quantileSeq(xs, 0.9)\`, \`math.min(xs)\`, \`math.max(xs)\`, \`math.sum(xs)\`.
- Polynomial trend / regression of order n — copy this exactly (it normalises x so the fit stays stable; NEVER hardcode coefficients):
    const xs = years, ys = values, n = 2;
    const x0 = math.min(xs), span = (math.max(xs) - x0) || 1;
    const A = xs.map(x => { const t = (x - x0) / span; return Array.from({ length: n + 1 }, (_, k) => t ** k); });
    const coef = math.lusolve(math.multiply(math.transpose(A), A), math.multiply(math.transpose(A), ys)).flat();
    const fit = xs.map(x => { const t = (x - x0) / span; return coef.reduce((s, c, k) => s + c * t ** k, 0); });
    // then plot \`fit\` as an extra line series alongside the data

RULES:
- The snippet MUST \`return { html, data, reset }\`: \`html\` is a string rendered into the panel (Tailwind classes work; dark mode via \`dark:\` variants); \`data\` is the raw result (plain objects/arrays); \`reset()\` cleans up (e.g. dispose ECharts).
- Each reply is a COMPLETE, standalone snippet — variables do NOT carry over between turns. On a follow-up/refinement, re-emit the WHOLE snippet (data prep + try/catch + the \`return { html, data, reset }\`) with your change applied; NEVER reply with a fragment, a diff, or a bare \`option = { … }\` / \`chart.setOption({ … })\`.
- Wrap everything in try/catch; in catch, call \`console.error(error)\` and \`return { html: '<div class="text-red-600 p-3 text-sm">' + error.message + '</div>', data: {}, reset: () => {} }\`.
- Charts: unique id \`'chart-' + Date.now()\`, give the container a pixel height, init inside \`requestAnimationFrame(() => { echarts.init(el).setOption({ ... }) })\`, and dispose it in \`reset()\`.
- Field values arrive as STRINGS — use \`parseNum(row['Col'])\` (or \`parseMoney\` for money) for any numeric column before arithmetic.
- Coerce before string ops: \`String(row['Col'] ?? '')\`. Use bracket access for column names with spaces.
- This is for ANALYSIS, not chat: even when the user asks a question (e.g. "what is the trend?"), DO NOT reply in words — write code that COMPUTES the answer and renders it (a short \`html\` sentence and/or a chart).

${example}

Output ONLY the raw JavaScript snippet — no markdown fences, no explanation, no prose, no JSON. The whole reply must be runnable JavaScript.`
    return [smallPrompt, pdfDocument].filter(Boolean).join('\n\n')
  }

  return [role, outputFormat, answerRules, environment, refinementRules, codingRules, apisSection, dataContext, catalogExample, pdfExample, example, mapExample, pdfDocument]
    .filter(Boolean)
    .join('\n\n')
}

// ---------------------------------------------------------------------------
// API error reason extractor — handles common REST error body shapes
// ---------------------------------------------------------------------------

function extractErrorReason(json: unknown): string | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null
  const obj = json as Record<string, unknown>
  if (typeof obj.reason  === 'string') return obj.reason   // Open-Meteo, etc.
  if (typeof obj.message === 'string') return obj.message  // generic REST
  if (typeof obj.error   === 'string') return obj.error    // simple string error
  if (obj.error && typeof obj.error === 'object') {        // Stripe-style nested
    const nested = obj.error as Record<string, unknown>
    if (typeof nested.message === 'string') return nested.message
  }
  return null
}

// ---------------------------------------------------------------------------
// JSON parsing
// ---------------------------------------------------------------------------

/** Extract the raw code from a small-model reply. The prompt asks for bare JS,
 *  but code models often wrap it in a ```fence (sometimes with a line of prose);
 *  pull the fenced block if present, otherwise take the text as-is. */
function stripCodeFences(raw: string): string {
  const text = raw.trim()
  const fenced = text.match(/```(?:js|javascript|json|ts)?\s*\n?([\s\S]*?)```/i)
  return (fenced ? fenced[1] : text).trim()
}

/** True if `code` parses as the body of an async function. Used in small-model
 *  mode to tell a real code reply from a prose reply (free identifiers like
 *  `data`/`echarts` compile fine; a French sentence does not). */
function compilesAsFunctionBody(code: string): boolean {
  if (!code) return false
  try {
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor as new (...args: string[]) => unknown
    new AsyncFunction(code)
    return true
  } catch {
    return false
  }
}

function tryParseJson(raw: string): Record<string, unknown> | null {
  let text = raw
    .replace(/^```[a-zA-Z]*\r?\n?/gm, '')
    .replace(/```\s*$/gm, '')
    .trim()

  function sanitize(s: string) { return s.replace(/\\([^"\\/bfnrtu])/g, '$1') }

  function normalizeNewlines(s: string): string {
    let out = ''; let inStr = false; let esc = false
    for (let i = 0; i < s.length; i++) {
      const c = s[i]
      if (esc) { esc = false; out += c; continue }
      if (c === '\\') { esc = true; out += c; continue }
      if (c === '"') { inStr = !inStr; out += c; continue }
      if (inStr) {
        const code = c.charCodeAt(0)
        if (c === '\n') { out += '\\n'; continue }
        if (c === '\r') { out += '\\r'; continue }
        if (c === '\t') { out += '\\t'; continue }
        if (code < 0x20) { out += `\\u${code.toString(16).padStart(4, '0')}`; continue }
      }
      out += c
    }
    return out
  }

  for (const candidate of [text, normalizeNewlines(text), sanitize(text), sanitize(normalizeNewlines(text))]) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
    } catch { /* try next */ }
  }

  const start = text.indexOf('{')
  if (start !== -1) {
    let depth = 0; let inString = false; let escape = false; let end = -1
    for (let i = start; i < text.length; i++) {
      const ch = text[i]
      if (escape) { escape = false; continue }
      if (ch === '\\') { escape = true; continue }
      if (ch === '"') { inString = !inString; continue }
      if (!inString) {
        if (ch === '{') depth++
        else if (ch === '}') { depth--; if (depth === 0) { end = i; break } }
      }
    }
    if (end !== -1) {
      const slice = text.slice(start, end + 1)
      for (const candidate of [slice, normalizeNewlines(slice), sanitize(slice), sanitize(normalizeNewlines(slice))]) {
        try {
          const parsed = JSON.parse(candidate)
          if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
        } catch { /* try next */ }
      }
    }
  }

  console.warn('[LocalAssistant] tryParseJson failed, first 200 chars:', raw.slice(0, 200))
  return null
}

// ---------------------------------------------------------------------------
// Sandbox srcdoc builder (moved from AnalysisPanel)
// ---------------------------------------------------------------------------

function esc(s: string): string { return s.replace(/<\//g, '<\\/') }

// darkMode MUST be set before the CDN loads — the CDN reads it during init.
// The theme extension is set in a second inline script right after the CDN
// (still synchronous, before DOMContentLoaded) so the CDN uses it when scanning.
const TAILWIND_DARK_MODE = `tailwind = { config: { darkMode: 'class' } }`

function buildSandboxDocumentFn(
  rows: Record<string, unknown>[],
  datasets: Record<string, Record<string, unknown>[]>,
  formula: string,
  darkMode: boolean,
  isPdf = false,
  pdfText = '',
  sandboxTheme?: Record<string, unknown>,
): string {
  const dataJson     = esc(JSON.stringify(rows))
  const datasetsJson = esc(JSON.stringify(datasets))
  const pdfTextJson  = esc(JSON.stringify(pdfText))
  const formulaJson  = esc(JSON.stringify(formula))
  const darkClass    = darkMode ? ' class="dark"' : ''

  return `<!DOCTYPE html>
<html${darkClass}>
<head>
<meta charset="utf-8">
<script>${TAILWIND_DARK_MODE}</script>
<script src="https://cdn.tailwindcss.com"></script>
${sandboxTheme ? `<script>tailwind.config=${esc(JSON.stringify({ darkMode: 'class', theme: sandboxTheme }))}</script>` : ''}
<script src="https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css">
<script src="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@turf/turf@6/turf.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/mathjs@13/lib/browser/math.js"></script>
${isPdf ? '<script src="https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js"></script>' : ''}
<style>
html,body{margin:0;padding:0;height:100%;box-sizing:border-box}
body{padding:8px;font-family:system-ui,-apple-system,sans-serif}
#r{height:100%}
*{box-sizing:border-box}
</style>
</head>
<body class="dark:bg-gray-900 dark:text-gray-100">
<div id="r"></div>
<script>
${isPdf ? 'if(window.pdfjsLib)window.pdfjsLib.GlobalWorkerOptions.workerSrc="";' : ''}
var __fp = {}, __fi = 0, __pdfData = null;
var pdfText = ${pdfTextJson};
window.fetch = function(url, opts) {
  opts = opts || {};
  var h = {};
  if (opts.headers) {
    if (typeof opts.headers.forEach === 'function') { opts.headers.forEach(function(v, k) { h[k] = v; }); }
    else { Object.keys(opts.headers).forEach(function(k) { h[k] = opts.headers[k]; }); }
  }
  var id = ++__fi;
  return new Promise(function(res, rej) {
    __fp[id] = { res: res, rej: rej };
    parent.postMessage({ t: 'fetch', id: id, url: String(url), method: opts.method || 'GET', headers: h, body: opts.body || null }, '*');
  });
};
window.addEventListener('message', function(e) {
  var d = e.data;
  if (!d) return;
  if (d.t === 'dark') { document.documentElement.classList.toggle('dark', d.v); return; }
  if (d.t === 'document-data') { __pdfData = new Uint8Array(d.buffer); __runFormula(); return; }
  if (d.t === 'export-pdf') {
    var style = document.createElement('style'); style.id = '__print-css';
    style.textContent = ['@media print {','  @page { margin: 12mm 10mm 18mm; }','  html, body { background: white !important; color: black !important; }','  canvas { max-width: 100% !important; page-break-inside: avoid; }','  .leaflet-container { page-break-inside: avoid; }','  #__pf { position: fixed; bottom: 0; left: 0; right: 0; text-align: center; font-size: 9px; color: #888; border-top: 1px solid #e5e7eb; padding: 3px 0; background: white; }','}'].join('');
    document.head.appendChild(style);
    var footer = document.createElement('div'); footer.id = '__pf'; footer.textContent = 'LocalFlow — ' + new Date().toLocaleDateString(); document.body.appendChild(footer);
    window.matchMedia('print').addEventListener('change', function cleanup(mq) { if (!mq.matches) { var s = document.getElementById('__print-css'); var f = document.getElementById('__pf'); if (s) s.remove(); if (f) f.remove(); mq.target.removeEventListener('change', cleanup); } });
    window.print(); return;
  }
  if (d.t === 'fetch-response' && __fp[d.id]) {
    var p = __fp[d.id]; delete __fp[d.id];
    if (d.error) { p.rej(new Error(d.error)); }
    else { p.res(new Response(d.body, { status: d.status, statusText: d.statusText, headers: new Headers(d.headers || {}) })); }
  }
});
// Column/number parsing helpers — single source of truth in ./sandboxHelpers.
// Injected as real source via toString() so the sandbox gets correct regex
// escapes (template-literal cooking would strip lone backslashes).
// Bound to canonical var names so a production minifier renaming the source
// function (e.g. parseMoney → t) doesn't leave the sandbox global undefined.
var parseMoney = ${parseMoney.toString()};
var parseNum = ${parseNum.toString()};
var splitCols = ${splitCols.toString()};
function __runFormula() {
  (async () => {
    const data = ${dataJson};
    const datasets = ${datasetsJson};
    // Error objects have non-enumerable props, so JSON.stringify(err) === '{}' and the
    // real message is lost. Render Errors as "Name: message"; other objects as JSON,
    // with a safe fallback for circular structures.
    const fmt = (x) => {
      if (x instanceof Error) return (x.name || 'Error') + ': ' + x.message;
      if (x !== null && typeof x === 'object') { try { return JSON.stringify(x); } catch (e) { return String(x); } }
      return String(x);
    };
    const mock = {
      log:   (...a) => parent.postMessage({ t: 'log',  m: a.map(fmt).join(' ') }, '*'),
      info:  (...a) => parent.postMessage({ t: 'log',  m: a.map(fmt).join(' ') }, '*'),
      warn:  (...a) => parent.postMessage({ t: 'warn', m: a.map(fmt).join(' ') }, '*'),
      error: (...a) => parent.postMessage({ t: 'error',m: a.map(fmt).join(' ') }, '*'),
    };
    const root = document.getElementById('r');
    try {
      var __AsyncFn = Object.getPrototypeOf(async function(){}).constructor;
      var __args = ['data', 'datasets', 'echarts', 'L', 'console', 'XLSX', 'jsPDF', 'pdfData', 'pdfjsLib', 'pdfText', 'parseMoney', 'parseNum', 'splitCols', 'math'];
      var __formula = ${formulaJson};
      var __vals = [data, datasets, typeof echarts !== 'undefined' ? echarts : undefined, typeof L !== 'undefined' ? L : undefined, mock, typeof XLSX !== 'undefined' ? XLSX : undefined, window.jspdf ? window.jspdf.jsPDF : undefined, __pdfData, typeof pdfjsLib !== 'undefined' ? pdfjsLib : undefined, pdfText, parseMoney, parseNum, splitCols, typeof math !== 'undefined' ? math : undefined];
      let result = await new __AsyncFn(...__args, __formula)(...__vals);
      // Tolerate a formula written as a function EXPRESSION instead of a bare body
      // (e.g. "async () => { ... return {html} }"): used as a body it is discarded
      // and yields undefined. Re-run it as an expression and resolve the function.
      if (result === undefined) {
        try {
          let maybe = await new __AsyncFn(...__args, 'return (' + __formula + ');')(...__vals);
          if (typeof maybe === 'function') maybe = await maybe();
          if (maybe && maybe.html) result = maybe;
        } catch (__e) { /* not a function expression — keep undefined */ }
      }
      if (typeof result === 'function') result = await result();   // formula did "return () => {...}"
      if (typeof result === 'string') result = { html: result, data: null, reset: function(){} };   // tolerate a bare HTML-string return (common from small models)
      if (result && result.html) {
        root.innerHTML = result.html;
        if (typeof tailwind !== 'undefined' && typeof tailwind.refresh === 'function') tailwind.refresh();
      }
      parent.postMessage({ t: 'done', data: (result && result.data !== undefined) ? result.data : null }, '*');
    } catch (err) {
      root.innerHTML = '<div class="bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 p-3 rounded-lg text-sm m-2"><strong>Error:</strong> ' + err.message + '</div>';
      parent.postMessage({ t: 'error', m: err.message }, '*');
    }
  })();
}
function resizeAllCharts() {
  if (typeof echarts === 'undefined') return;
  document.querySelectorAll('[_echarts_instance_]').forEach(function(el) {
    el.style.width = '';
    var inst = echarts.getInstanceByDom(el);
    if (inst) inst.resize();
  });
}
if (window.ResizeObserver) { new ResizeObserver(resizeAllCharts).observe(document.getElementById('r')); }
if (window.matchMedia) { window.matchMedia('print').addEventListener('change', resizeAllCharts); }
// PDF datasets: signal ready and wait for document-data; others run immediately
if (${isPdf ? 'true' : 'false'}) { parent.postMessage({ t: 'ready' }, '*'); } else { __runFormula(); }
</script>
</body>
</html>`
}

// ===========================================================================
// LocalAssistant class
// ===========================================================================

/** Internal dataset storage — tabular rows or a raw document buffer with extracted text */
type InternalDataset =
  | { type: 'table'; rows: Record<string, unknown>[] }
  | { type: 'pdf';   buffer: ArrayBuffer; extractedText: string; pageCount: number }

export class LocalAssistant {
  private _config: LocalAssistantConfig
  /** Ordered map preserving insertion order for dataset display */
  private _datasets: Map<string, InternalDataset> = new Map()
  private _activeDatasetName: string | null = null
  private _apiConfigs: ApiConfig[] = []
  private _apiPrefs: ApiPreference[] = []
  private _history: ConversationTurn[] = []
  private _matchHook: AnalysisMatchHook | null = null
  private _lastSystemPrompt = ''
  private _lastPdfPrompted: string | null = null  // active PDF name of the current history (reset on switch)
  private _pendingFormulaFeedback: string | null = null
  private _listeners: Map<string, Set<Function>> = new Map()
  private _iframe?: HTMLIFrameElement
  private _fetchListener?: (e: MessageEvent) => void
  private _feedbackDoneFor: Set<string> = new Set()

  constructor(config: LocalAssistantConfig) {
    this._config = { ...config }
    if (config.apiPreferences) this._apiPrefs = [...config.apiPreferences]
  }

  // -------------------------------------------------------------------------
  // Configuration getters / setters
  // -------------------------------------------------------------------------

  get llm(): LLMConfig { return { ...this._config.llm } }
  set llm(v: LLMConfig) { this._config.llm = { ...v }; this._emit('llm:change', { ...this._config.llm }) }

  /** Capability tier of the active model — set it from the selected model's
   *  `LLMModelInfo.size`. 'small' leans the system prompt for local/edge models;
   *  defaults to 'large' (full prompt). */
  get modelSize(): 'small' | 'medium' | 'large' { return this._config.modelSize ?? 'large' }
  set modelSize(v: 'small' | 'medium' | 'large') { this._config.modelSize = v }

  /** Encrypt a plain Gemini API key via the proxy and store it. Emits 'llm:change'. */
  async setLlmApiKey(plainKey: string): Promise<void> {
    const encrypted = this._config.proxy.isEncrypted(plainKey)
      ? plainKey
      : await this._config.proxy.encryptMessage(plainKey)
    this._config.llm = { ...this._config.llm, apiKey: encrypted }
    this._emit('llm:change', { ...this._config.llm })
  }

  /** Access the proxy client (e.g. for manual encrypt/decrypt or session checks). */
  get proxy(): Proxy { return this._config.proxy }

  get darkMode(): boolean { return this._config.darkMode ?? false }
  set darkMode(v: boolean) { this._config.darkMode = v }

  get pdfFormulaRevision(): boolean { return this._config.pdfFormulaRevision ?? false }
  set pdfFormulaRevision(v: boolean) { this._config.pdfFormulaRevision = v }

  get resultContainer(): ResultContainer | undefined { return this._config.resultContainer }
  set resultContainer(v: ResultContainer) { this._config.resultContainer = v }

  get sandboxPermissions(): string[] { return this._config.sandboxPermissions ?? DEFAULT_SANDBOX_PERMISSIONS }
  set sandboxPermissions(v: string[]) { this._config.sandboxPermissions = v }

  /** Tailwind theme injected into the sandbox document; lets the host match the app's palette. */
  get sandboxTheme(): Record<string, unknown> | undefined { return this._config.sandboxTheme }
  set sandboxTheme(v: Record<string, unknown> | undefined) { this._config.sandboxTheme = v }

  // -------------------------------------------------------------------------
  // Dataset management
  // -------------------------------------------------------------------------

  addDataset(name: string, rows: object[]): void {
    this._datasets.set(name, { type: 'table', rows: rows as Record<string, unknown>[] })
    if (this._datasets.size === 1) this._activeDatasetName = name
    this._emit('dataset:change')
  }

  /** Add a PDF document as a dataset. Pass extracted text so the LLM can see the content. */
  addPdfDataset(name: string, buffer: ArrayBuffer, extractedText = '', pageCount = 0): void {
    this._datasets.set(name, { type: 'pdf', buffer, extractedText, pageCount })
    if (this._datasets.size === 1) this._activeDatasetName = name
    this._emit('dataset:change')
  }

  removeDataset(name: string): void {
    this._datasets.delete(name)
    if (this._activeDatasetName === name) {
      this._activeDatasetName = [...this._datasets.keys()][0] ?? null
    }
    this._emit('dataset:change')
  }

  updateDataset(name: string, rows: object[]): void {
    if (this._datasets.has(name)) {
      this._datasets.set(name, { type: 'table', rows: rows as Record<string, unknown>[] })
      this._emit('dataset:change')
    }
  }

  getDataset(name: string): Record<string, unknown>[] | undefined {
    const entry = this._datasets.get(name)
    return entry?.type === 'table' ? entry.rows : undefined
  }

  /** Returns only tabular datasets (PDF datasets are excluded — they have no rows). */
  getDatasets(): Record<string, Record<string, unknown>[]> {
    const result: Record<string, Record<string, unknown>[]> = {}
    for (const [name, entry] of this._datasets) {
      if (entry.type === 'table') result[name] = entry.rows
    }
    return result
  }

  setActiveDataset(name: string): void {
    if (this._datasets.has(name)) this._activeDatasetName = name
  }

  getActiveDataset(): { name: string; rows: Record<string, unknown>[]; columns: string[]; type: 'table' | 'pdf' } | null {
    if (!this._activeDatasetName) return null
    const entry = this._datasets.get(this._activeDatasetName)
    if (!entry) return null
    if (entry.type === 'pdf') return { name: this._activeDatasetName, rows: [], columns: [], type: 'pdf' }
    return { name: this._activeDatasetName, rows: entry.rows, columns: entry.rows.length > 0 ? Object.keys(entry.rows[0]) : [], type: 'table' }
  }

  /** Returns the raw PDF buffer for the active dataset, or null if not a PDF. */
  getActivePdfBuffer(): ArrayBuffer | null {
    if (!this._activeDatasetName) return null
    const entry = this._datasets.get(this._activeDatasetName)
    return entry?.type === 'pdf' ? entry.buffer : null
  }

  getActivePdfExtractedText(): string {
    if (!this._activeDatasetName) return ''
    const entry = this._datasets.get(this._activeDatasetName)
    return entry?.type === 'pdf' ? entry.extractedText : ''
  }

  getActivePdfPageCount(): number {
    if (!this._activeDatasetName) return 0
    const entry = this._datasets.get(this._activeDatasetName)
    return entry?.type === 'pdf' ? entry.pageCount : 0
  }

  clearDatasets(): void {
    this._datasets.clear()
    this._activeDatasetName = null
    this._emit('dataset:change')
  }

  // -------------------------------------------------------------------------
  // External API management
  // -------------------------------------------------------------------------

  setApiConfigs(configs: ApiConfig[]): void {
    this._apiConfigs = configs
    this._emit('configs:change', [...this._apiConfigs])
  }
  getApiConfigs(): ApiConfig[] { return this._apiConfigs }

  setApiPreferences(prefs: ApiPreference[]): void {
    this._apiPrefs = prefs
    this._emit('prefs:change', [...this._apiPrefs])
  }
  getApiPreferences(): ApiPreference[] { return this._apiPrefs }

  activateApi(id: string): void {
    const p = this._apiPrefs.find(p => p.id === id)
    if (p) p.enabled = true
    else this._apiPrefs.push({ id, enabled: true })
    this._emit('prefs:change', [...this._apiPrefs])
  }

  deactivateApi(id: string): void {
    const p = this._apiPrefs.find(p => p.id === id)
    if (p) p.enabled = false
    this._emit('prefs:change', [...this._apiPrefs])
  }

  async setApiUserKey(id: string, plainKey: string): Promise<void> {
    const encrypted = this._config.proxy.isEncrypted(plainKey)
      ? plainKey
      : await this._config.proxy.encryptMessage(plainKey)
    const p = this._apiPrefs.find(p => p.id === id)
    if (p) p.encryptedUserKey = encrypted
    else this._apiPrefs.push({ id, enabled: true, encryptedUserKey: encrypted })
    this._emit('prefs:change', [...this._apiPrefs])
  }

  getActivatedApis(): ActivatedApi[] {
    return this._apiConfigs
      .filter(c => c.force || (this._apiPrefs.find(p => p.id === c.id)?.enabled ?? false))
      .map(c => ({ config: c, encryptedUserKey: this._apiPrefs.find(p => p.id === c.id)?.encryptedUserKey }))
  }

  /** Fetch available APIs from the proxy and store them internally. */
  async fetchApiConfigs(): Promise<ApiConfig[]> {
    try {
      this._apiConfigs = await this._config.proxy.getApiConfigs()
      this._emit('configs:change', [...this._apiConfigs])
      return this._apiConfigs
    } catch { return [] }
  }

  // -------------------------------------------------------------------------
  // Conversation history helpers
  // -------------------------------------------------------------------------

  getHistory(): ConversationTurn[] { return [...this._history] }
  setHistory(h: ConversationTurn[]): void { this._history = h }
  appendHistory(turn: ConversationTurn): void { this._history.push(turn) }
  clearHistory(): void { this._history = []; this._pendingFormulaFeedback = null }

  /**
   * Record the outcome of a formula execution so the LLM can see it in the next prompt.
   * Call this after each sandbox run with the returned data and collected console messages.
   */
  recordFormulaResult(data: unknown, logs: string[]): void {
    const parts: string[] = [
      '[Previous formula execution result — use this to understand what happened and improve the next formula. Do NOT re-use these values as literals.]',
    ]

    if (logs.length > 0) {
      parts.push('\nConsole output:')
      const capped = logs.slice(0, 40)
      parts.push(...capped.map(l => `  ${l}`))
      if (logs.length > 40) parts.push(`  … (${logs.length - 40} more lines omitted)`)
    } else {
      parts.push('\nConsole output: (none)')
    }

    if (data !== null && data !== undefined) {
      parts.push('\nReturned data:')
      // Summarise large arrays to avoid bloating the prompt
      let preview: unknown = data
      if (Array.isArray(data) && data.length > 5) {
        preview = { _first5: data.slice(0, 5), _totalItems: data.length }
      }
      const json = JSON.stringify(preview, null, 2)
      parts.push('```json')
      parts.push(json.length > 3000 ? json.slice(0, 3000) + '\n… (truncated)' : json)
      parts.push('```')
    } else {
      parts.push('\nReturned data: null')
    }

    this._pendingFormulaFeedback = parts.join('\n')
  }
  // -------------------------------------------------------------------------
  // PDF feedback loop
  // -------------------------------------------------------------------------

  shouldRunFeedbackLoop(pdfName: string): boolean {
    return !!this._config.pdfFormulaRevision && !this._feedbackDoneFor.has(pdfName)
  }

  markFeedbackDone(pdfName: string): void {
    this._feedbackDoneFor.add(pdfName)
  }

  /**
   * Execute a formula in a hidden off-screen iframe and return its result — the
   * "headless" counterpart to executeFormula. Runs against the current datasets /
   * active dataset and proxies fetch + PDF document data identically to the visible
   * sandbox, but renders nothing and emits no events: the result is the resolved
   * value rather than a `formula:done` / `formula:error` event.
   *
   * Always resolves (never rejects): `.data` is the formula's returned data (or
   * null), `.logs` is the captured console output, and `.error` is set when the
   * formula threw or the 30s timeout elapsed.
   */
  executeFormulaSilently(formula: string): Promise<{ data: unknown; logs: string[]; error?: string }> {
    return new Promise((resolve) => {
      const logs: string[] = []
      const iframe = document.createElement('iframe')
      iframe.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px;border:none;visibility:hidden'
      for (const perm of this.sandboxPermissions) iframe.sandbox.add(perm)
      iframe.srcdoc = this.buildSandboxDocument(formula)

      const timeout = setTimeout(() => { cleanup(); resolve({ data: null, logs, error: 'Formula execution timed out after 30s' }) }, 30_000)

      const listener = async (e: MessageEvent) => {
        if (e.source !== iframe.contentWindow) return
        const d = e.data
        if (!d) return

        if (d.t === 'done' || d.t === 'error') {
          let error: string | undefined
          if (d.t === 'error') {
            error = d.m ?? ''
            logs.push(`ERROR: ${error}`)
            window.console.error('[formula]', error)
          }
          clearTimeout(timeout)
          cleanup()
          resolve({ data: d.t === 'done' ? (d.data ?? null) : null, logs, error })
          return
        }
        if (d.t === 'log' || d.t === 'warn') {
          const prefix = d.t === 'warn' ? 'WARN' : 'LOG'
          const msg = d.m ?? ''
          logs.push(`${prefix}: ${msg}`)
          window.console[d.t === 'warn' ? 'warn' : 'log']('[formula]', msg)
          return
        }
        if (d.t === 'ready') {
          const buffer = this.getActivePdfBuffer()
          if (buffer) iframe.contentWindow?.postMessage({ t: 'document-data', buffer }, '*')
          return
        }
        if (d.t === 'fetch') {
          const { id, url, method, headers, body } = d
          try {
            const res = await this.proxyFetch(url, { method, headers, body })
            const resBody = await res.text()
            const resHeaders: Record<string, string> = {}
            res.headers.forEach((v: string, k: string) => { resHeaders[k] = v })
            iframe.contentWindow?.postMessage(
              { t: 'fetch-response', id, status: res.status, statusText: res.statusText, headers: resHeaders, body: resBody },
              '*',
            )
          } catch (err) {
            iframe.contentWindow?.postMessage(
              { t: 'fetch-response', id, error: err instanceof Error ? err.message : String(err) },
              '*',
            )
          }
        }
      }

      function cleanup() {
        window.removeEventListener('message', listener)
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe)
      }

      window.addEventListener('message', listener)
      document.body.appendChild(iframe)
    })
  }

  private _llmRequestBase(): Omit<LLMRequest, 'system' | 'messages'> {
    const { llm } = this._config
    return { modelId: llm.modelId, protocol: llm.protocol, model: llm.model, apiKey: llm.apiKey, baseUrl: llm.baseUrl }
  }

  private _turnsAsMessages(turns: ConversationTurn[]): LLMMessage[] {
    return turns.map(t => ({
      role: t.role === 'model' ? 'assistant' as const : 'user' as const,
      content: t.parts[0]?.text ?? '',
    }))
  }

  /**
   * Silently calls the LLM to revise a formula based on its runtime console output.
   * Does NOT modify conversation history — this is a transparent background round-trip.
   * Returns the revised formula string, or null if revision failed / no formula returned.
   */
  async reviseFormula(_formula: string, logs: string[]): Promise<string | null> {
    const logBlock = logs.length > 0
      ? (logs.length <= 200
          ? logs.join('\n')
          : logs.slice(0, 100).join('\n') + '\n... (truncated) ...\n' + logs.slice(-100).join('\n'))
      : '(no console output — formula may be missing the required console.log statements)'

    const revisionMessage = [
      'The formula you just generated was executed in the sandbox. Here are the runtime logs:',
      '',
      '```',
      logBlock,
      '```',
      '',
      'Inspect the logs and return the improved formula taking the logs into account.',
    ].join('\n')

    try {
      const llmResponse = await this._config.proxy.callLLM({
        ...this._llmRequestBase(),
        system: this._lastSystemPrompt,
        messages: [
          ...this._turnsAsMessages(this._history),
          { role: 'user', content: revisionMessage },
        ],
        options: { thinking: true, json: true, temperature: 0.3 },
      })
      const parsed = tryParseJson(llmResponse.text)
      if (parsed?.formula) return String(parsed.formula)
    } catch {
      /* revision is best-effort — swallow errors */
    }
    return null
  }

  /**
   * Transparently ask the LLM to fix a syntax error in a formula.
   * Does NOT modify conversation history. Returns the fixed formula or null on failure.
   */
  private async _syntaxHealFormula(
    _formula: string,
    syntaxError: string,
    messages: LLMMessage[],
  ): Promise<string | null> {
    const userMsg = `The formula contains a JavaScript syntax error: "${syntaxError}"\nPlease fix it and return only the corrected JSON with the "formula" field.`
    try {
      const llmResponse = await this._config.proxy.callLLM({
        ...this._llmRequestBase(),
        system: this._lastSystemPrompt,
        messages: [...messages, { role: 'user', content: userMsg }],
        options: { thinking: true, json: true, temperature: 0.3 },
      })
      const parsed = tryParseJson(llmResponse.text)
      if (parsed?.formula) return String(parsed.formula)
    } catch { /* best-effort */ }
    return null
  }

  getLastSystemPrompt(): string { return this._lastSystemPrompt }

  getLastFormula(): string | null {
    for (let i = this._history.length - 1; i >= 0; i--) {
      if (this._history[i].role === 'model') {
        try {
          const p = JSON.parse(this._history[i].parts[0]?.text ?? '{}')
          if (p.formula) return p.formula as string
        } catch { /* skip */ }
      }
    }
    return null
  }

  /** Title of the last assistant response — used internally to build richer match queries. */
  getLastResponseTitle(): string | null {
    for (let i = this._history.length - 1; i >= 0; i--) {
      if (this._history[i].role === 'model') {
        try {
          const p = JSON.parse(this._history[i].parts[0]?.text ?? '{}')
          if (p.title) return p.title as string
        } catch { /* skip */ }
      }
    }
    return null
  }

  // -------------------------------------------------------------------------
  // System prompt (public helper so the UI can inspect it)
  // -------------------------------------------------------------------------

  buildCurrentSystemPrompt(exampleAnalysis?: AnalysisSuggestion | null): string {
    const active = this.getActiveDataset()
    return buildSystemPromptFn(
      active?.columns ?? [],
      active?.rows ?? [],
      this.getDatasets(),
      this.getActivatedApis(),
      active?.type ?? 'table',
      this._activeDatasetName,
      this.getActivePdfExtractedText(),
      this.getActivePdfPageCount(),
      exampleAnalysis,
      this._config.modelSize,
    )
  }

  // -------------------------------------------------------------------------
  // Analysis match hook
  // -------------------------------------------------------------------------

  setAnalysisMatchHook(fn: AnalysisMatchHook | null): void { this._matchHook = fn }

  async resolveAnalysisMatch(query: string): Promise<AnalysisMatchResult | null> {
    if (!this._matchHook) return null
    const active = this.getActiveDataset()
    const ctx: AnalysisMatchContext = {
      history: this._history,
      datasets: this.getDatasets(),
      activeDatasetName: this._activeDatasetName,
      activeColumns: active?.columns ?? [],
    }
    try { return await this._matchHook(query, ctx) } catch { return null }
  }

  // -------------------------------------------------------------------------
  // Main send() — calls the LLM and returns the parsed response
  // -------------------------------------------------------------------------

  async prompt(userMessage: string, opts?: { exampleAnalysis?: AnalysisSuggestion | null }): Promise<AssistantResponse> {
    const active = this.getActiveDataset()
    let systemPrompt = buildSystemPromptFn(
      active?.columns ?? [],
      active?.rows ?? [],
      this.getDatasets(),
      this.getActivatedApis(),
      active?.type ?? 'table',
      this._activeDatasetName,
      this.getActivePdfExtractedText(),
      this.getActivePdfPageCount(),
      opts?.exampleAnalysis ?? null,
      this._config.modelSize,
    )
    // App-supplied domain context goes first so it frames everything below.
    if (this._config.appContext) {
      systemPrompt = `# CONTEXT\n${this._config.appContext}\n\n${systemPrompt}`
    }
    this._lastSystemPrompt = systemPrompt

    // Small/local models emit only code (see buildSystemPromptFn): turn JSON mode
    // off and wrap the returned snippet into the response ourselves.
    const small = (this._config.modelSize ?? 'large') === 'small'

    // The PDF document text rides in the system prompt (buildSystemPromptFn), so it
    // is bounded by the upload-size limit — never the per-message prompt-char limit —
    // and the user message stays just the question. Reset history when switching to a
    // different PDF so prior Q&A about another document doesn't leak in.
    let llmMessage = userMessage
    if (active?.type === 'pdf') {
      if (this._lastPdfPrompted && this._lastPdfPrompted !== active.name && this._history.length > 0) {
        this._history = []
        this._emit('history:reset')
      }
      this._lastPdfPrompted = active.name
    }

    // The previous run's execution trace travels as message `context`, not inside
    // `content`: it's machine-generated (and can be several KB), so the proxy
    // forwards it to the model but does not charge it against the per-message
    // prompt-char limit. It stays at the conversation tail, leaving the cacheable
    // system prompt untouched.
    const feedback = this._pendingFormulaFeedback
    this._pendingFormulaFeedback = null

    // Notify before the network call so the UI can update immediately
    {
      const dataset = this._activeDatasetName ?? ''
      if (active?.type === 'pdf') {
        this._emit('data:llm', { kind: 'pdf',   query: userMessage, dataset, pages:   this.getActivePdfPageCount() })
      } else if (active && active.columns.length > 0) {
        this._emit('data:llm', { kind: 'table', query: userMessage, dataset, columns: active.columns.length })
      } else {
        this._emit('data:llm', { kind: 'text',  query: userMessage, dataset: '' })
      }
    }

    // On a small-mode follow-up the instruct-tuned model loves to answer with a diff
    // ("// ... existing code", a bare `option = {…}`) plus prose, which then references
    // variables from the prior turn that no longer exist. A rule buried in the system
    // prompt loses to that reflex, so put the directive where it carries the most
    // weight: appended to the user's own message — the last thing read before output.
    // (Only the clean `llmMessage` is stored in history below, never this suffix.)
    const refineSuffix = (small && this._history.length > 0)
      ? '\n\n---\nIMPORTANT — this is a follow-up. Re-output your ENTIRE previous snippet with this change applied: the whole thing from `try {` to the final `}`, including all data preparation and the closing `return { html, data, reset }`. Do NOT output a diff, partial code, placeholder comments (e.g. `// ... existing code`), a bare `option = {…}` / `setOption({…})`, or any prose/markdown — ONLY the complete runnable snippet.'
      : ''

    const llmResponse = await this._config.proxy.callLLM({
      ...this._llmRequestBase(),
      system: systemPrompt,
      messages: [
        ...this._turnsAsMessages(this._history),
        { role: 'user', content: llmMessage + refineSuffix, ...(feedback ? { context: feedback } : {}) },
      ],
      options: small ? { json: false, temperature: 0.2 } : { thinking: true, json: true, temperature: 0.5 },
    })

    if (!llmResponse.text) throw new Error('LLM returned an empty response')

    let formula = ''; let answer = ''; let title = ''; let description = ''
    let dependencies: AnalysisDependencies | undefined

    if (small) {
      // Code-only reply: the snippet IS the formula; wrap it with a generic answer
      // and a title taken from the start of the user's question (the model writes
      // no title in this mode).
      // Code/small models sometimes answer a question in prose instead of
      // returning a snippet. Detect that (the reply doesn't compile as a function
      // body) and surface it as a plain text answer, rather than feeding prose to
      // the sandbox as a formula (which throws "Unexpected identifier …").
      const code = stripCodeFences(llmResponse.text)
      const q = userMessage.trim()
      title = q.length > 60 ? q.slice(0, 60).replace(/\s+\S*$/, '') + '…' : q
      if (compilesAsFunctionBody(code)) {
        formula = code
        answer = 'Voici le résultat.'
      } else {
        answer = code
      }
    } else {
      const parsed = tryParseJson(llmResponse.text)
      if (parsed) {
        formula      = String(parsed.formula     ?? '')
        answer       = String(parsed.answer      ?? '')
        title        = String(parsed.title       ?? '')
        description  = String(parsed.description ?? '')
        if (parsed.dependencies && typeof parsed.dependencies === 'object') {
          const raw = parsed.dependencies as Record<string, unknown>
          dependencies = {
            data: Array.isArray(raw.data) ? (raw.data as unknown[]).filter((x): x is string => typeof x === 'string') : [],
            datasets: (raw.datasets && typeof raw.datasets === 'object' && !Array.isArray(raw.datasets))
              ? Object.fromEntries(
                  Object.entries(raw.datasets as Record<string, unknown>)
                    .filter(([, v]) => Array.isArray(v))
                    .map(([k, v]) => [k, (v as unknown[]).filter((x): x is string => typeof x === 'string')])
                )
              : {},
          }
        }
      } else {
        answer = llmResponse.text.trim()
      }
    }

    // --- Debug trace ---------------------------------------------------------
    // Enable in the browser console with: localStorage.localflow_debug = '1'
    // Then re-run an analysis and copy the "LOCALFLOW DEBUG" block from the
    // console. It captures the full exchange (prompt, conversation, raw model
    // output, and how it was wrapped) so the whole context can be inspected.
    try {
      if (typeof localStorage !== 'undefined' && localStorage.getItem('localflow_debug')) {
        // eslint-disable-next-line no-console
        console.log(
          '\n===== LOCALFLOW DEBUG =====\n' +
          JSON.stringify({
            modelId: this._config.llm.modelId ?? '(proxy default)',
            modelSize: this._config.modelSize ?? 'large',
            jsonMode: !small,
            systemPrompt,
            messages: [
              ...this._turnsAsMessages(this._history),
              { role: 'user', content: llmMessage },
            ],
            rawResponse: llmResponse.text,
            thoughts: llmResponse.thoughts ?? null,
            wrapped: { title, answer, formula },
          }, null, 2) +
          '\n===== END LOCALFLOW DEBUG =====\n',
        )
      }
    } catch { /* never let debug logging break a run */ }

    // Syntax-check the formula and transparently self-heal on error
    const maxHealing = small ? 0 : (this._config.formulaHealingRetries ?? 1)
    if (formula && maxHealing > 0) {
      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor as new (...args: string[]) => unknown
      const healMessages: LLMMessage[] = [
        ...this._turnsAsMessages(this._history),
        { role: 'user',      content: llmMessage },
        { role: 'assistant', content: JSON.stringify({ answer, formula, title, description }) },
      ]
      for (let attempt = 0; attempt < maxHealing; attempt++) {
        try { new AsyncFunction(formula); break }
        catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e)
          const fixed = await this._syntaxHealFormula(formula, errMsg, healMessages)
          if (!fixed) break
          formula = fixed
          healMessages[healMessages.length - 1] = { role: 'assistant', content: JSON.stringify({ answer, formula, title, description }) }
        }
      }
    }

    // Append to conversation history — store llmMessage so PDF context persists across
    // turns. In small/code-only mode, replay the assistant's turn as the raw code it
    // actually produced (or its prose answer), NOT the synthesized JSON wrapper —
    // otherwise the model sees its own past replies as JSON, which contradicts the
    // "output only raw JavaScript, no JSON" instruction and breaks follow-ups.
    const assistantTurn = small
      ? (formula || answer)
      : JSON.stringify({ answer, formula, title, description, dependencies })
    this._history = [
      ...this._history,
      { role: 'user',  parts: [{ text: llmMessage }] },
      { role: 'model', parts: [{ text: assistantTurn }] },
    ]

    const response: AssistantResponse = {
      answer,
      formula,
      title: title || undefined,
      description: description || undefined,
      dependencies,
      systemPrompt,
    }

    this._emit('message', response)

    // Auto-render when a result container is configured
    if (response.formula && this._config.resultContainer) {
      this.executeFormula(response.formula)
    }

    return response
  }

  // -------------------------------------------------------------------------
  // Sandbox helpers
  // -------------------------------------------------------------------------

  /** Builds the full srcdoc HTML for the analysis iframe. */
  buildSandboxDocument(formula: string): string {
    const active = this.getActiveDataset()
    return buildSandboxDocumentFn(
      active?.rows ?? [],
      this.getDatasets(),
      formula,
      this.darkMode,
      active?.type === 'pdf',
      this.getActivePdfExtractedText(),
      this._config.sandboxTheme,
    )
  }

  /**
   * Proxies an API fetch from the sandbox iframe through the LocalFlow proxy.
   * The BYOK encrypted key is injected automatically when a matching API is found.
   */
  async proxyFetch(
    url: string,
    opts: { method: string; headers: Record<string, string>; body: string | null },
  ): Promise<Response> {
    const matched = this.getActivatedApis().find(a => {
      const bases = Array.isArray(a.config.baseUrl) ? a.config.baseUrl : [a.config.baseUrl]
      return bases.some(b => url.startsWith(b))
    })
    const headers: Record<string, string> = { ...opts.headers }
    if (matched?.encryptedUserKey) headers['X-Proxy-API-Key'] = matched.encryptedUserKey

    // Emit 'api:blocked' when a URL that isn't in the activated API list fails.
    // Covers both HTTP error responses and network-level errors (CORS, timeout, etc.)
    const emitIfUnmatched = () => {
      if (matched) return
      let hostname = url
      try { hostname = new URL(url).hostname } catch { /* use full url */ }
      const apiConfig = this._apiConfigs.find(c => {
        const bases = Array.isArray(c.baseUrl) ? c.baseUrl : [c.baseUrl]
        return bases.some(b => url.startsWith(b))
      }) ?? null
      this._emit('api:blocked', { url, hostname, apiConfig })
    }

    const method = opts.method || 'GET'
    const apiConfig = matched?.config ?? null

    let res: Response
    try {
      res = await this._config.proxy.proxyApiCall(url, method, headers, opts.body)
    } catch (err) {
      emitIfUnmatched()
      this._emit('data:api-proxy', { url, method, body: opts.body ?? null, apiConfig })
      throw err
    }

    if (!res.ok) {
      emitIfUnmatched()
      // Detect API-level config errors on active APIs (expired key, quota, etc.)
      if (matched) {
        try {
          const reason = extractErrorReason(await res.clone().json())
          if (reason) {
            let hostname = url
            try { hostname = new URL(url).hostname } catch { /* use full url */ }
            this._emit('api:error', { url, hostname, apiConfig: matched.config, reason })
          }
        } catch { /* body not JSON or empty — skip */ }
      }
    }

    this._emit('data:api-proxy', { url, method, body: opts.body ?? null, apiConfig, status: res.status })
    return res
  }

  // -------------------------------------------------------------------------
  // Formula execution in the managed iframe
  // -------------------------------------------------------------------------

  /**
   * Renders a formula in the configured resultContainer. Creates and manages
   * the sandboxed iframe, proxies fetch calls, and emits 'formula:done' /
   * 'formula:error' events when execution completes.
   */
  executeFormula(formula: string): void {
    const container = this._resolveContainer()
    if (!container) {
      console.warn('[LocalAssistant] executeFormula: no resultContainer configured')
      return
    }

    // Tear down previous run
    if (this._fetchListener) {
      window.removeEventListener('message', this._fetchListener)
      this._fetchListener = undefined
    }

    container.innerHTML = ''
    const iframe = document.createElement('iframe')
    for (const perm of this.sandboxPermissions) iframe.sandbox.add(perm)
    iframe.style.cssText = 'width:100%;height:100%;border:none;display:block'
    iframe.srcdoc = this.buildSandboxDocument(formula)
    container.appendChild(iframe)
    this._iframe = iframe

    const listener = async (e: MessageEvent) => {
      if (e.source !== iframe.contentWindow) return
      const d = e.data
      if (!d) return

      if (d.t === 'done')  { this._emit('formula:done',  { data: d.data ?? null }); return }
      if (d.t === 'error') { this._emit('formula:error', { message: d.m ?? '' });   return }

      if (d.t === 'ready') {
        const buffer = this.getActivePdfBuffer()
        if (buffer) iframe.contentWindow?.postMessage({ t: 'document-data', buffer }, '*')
        return
      }

      if (d.t === 'fetch') {
        const { id, url, method, headers, body } = d
        try {
          const res = await this.proxyFetch(url, { method, headers, body })
          const resBody = await res.text()
          const resHeaders: Record<string, string> = {}
          res.headers.forEach((v: string, k: string) => { resHeaders[k] = v })
          iframe.contentWindow?.postMessage(
            { t: 'fetch-response', id, status: res.status, statusText: res.statusText, headers: resHeaders, body: resBody },
            '*',
          )
        } catch (err) {
          iframe.contentWindow?.postMessage(
            { t: 'fetch-response', id, error: err instanceof Error ? err.message : String(err) },
            '*',
          )
        }
      }
    }

    this._fetchListener = listener
    window.addEventListener('message', listener)
  }

  /** Remove the managed iframe and clean up all listeners. */
  destroy(): void {
    if (this._fetchListener) {
      window.removeEventListener('message', this._fetchListener)
      this._fetchListener = undefined
    }
    if (this._iframe?.parentNode) {
      this._iframe.parentNode.removeChild(this._iframe)
    }
    this._iframe = undefined
    this._listeners.clear()
  }

  private _resolveContainer(): HTMLElement | null {
    const c = this._config.resultContainer
    if (!c) return null
    if (typeof c === 'function') return c()
    if (typeof c === 'string') return document.querySelector<HTMLElement>(c)
    return c
  }

  // -------------------------------------------------------------------------
  // Event system
  // -------------------------------------------------------------------------

  on(event: string, listener: Function): void {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set())
    this._listeners.get(event)!.add(listener)
  }

  off(event: string, listener: Function): void {
    this._listeners.get(event)?.delete(listener)
  }

  emit(event: string, ...args: unknown[]): void {
    this._emit(event, ...args)
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private _emit(event: string, ...args: unknown[]): void {
    this._listeners.get(event)?.forEach(fn => {
      try { fn(...args) } catch { /* don't let listener errors propagate */ }
    })
  }
}
