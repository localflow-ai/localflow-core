import type {
  LocalAssistantConfig, LLMConfig, ResultContainer,
  AssistantResponse, AnalysisDependencies, AnalysisSuggestion,
  ConversationTurn, ApiConfig, ApiPreference, ActivatedApi,
  AnalysisMatchHook, AnalysisMatchContext, AnalysisMatchResult,
} from './types'
import type { ProxyClient } from './ProxyClient'
import { darkGray, darkVars } from './theme'

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
    const nums = nonNull.map(v => Number(v)).filter(v => !isNaN(v))
    if (nums.length > 0 && nums.length === nonNull.length) {
      lines.push(`- ${col}: number — range ${Math.min(...nums)} … ${Math.max(...nums)}`)
      continue
    }
    const strs = nonNull.map(v => String(v))
    const unique = Array.from(new Set(strs)).sort()
    if (unique.length <= CATEGORICAL_MAX_ROWS || rows.length <= CATEGORICAL_MAX_ROWS) {
      lines.push(`- ${col}: categorical — [${unique.map(v => `"${v}"`).join(', ')}]`)
      continue
    }
    const sample = unique.slice(0, 3).map(v => `"${v}"`).join(', ')
    lines.push(`- ${col}: string — ${unique.length} distinct values (e.g. ${sample})`)
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
  _pdfExtractedText: string,
  pdfPageCount: number,
  exampleAnalysis?: AnalysisSuggestion | null,
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
The formula runs as the body of an async function. The following globals are injected at runtime:
- \`data\`: Array of row objects for the active tab. Each row's keys match the column names listed in ACTIVE DATA CONTEXT below.
- \`datasets\`: Object containing all open tabs keyed by tab name (filename). Includes the active tab. Example: \`datasets['customers.csv']\` returns the full row array for that tab. Tab names and schemas are listed in ALL OPEN DATASETS below.
- \`echarts\`: Apache ECharts 5 library. Use it to draw all charts — bar, line, pie, scatter, heatmap, treemap, sunburst, sankey, candlestick, radar, etc. Always call \`echarts.init(document.getElementById(id))\` inside \`requestAnimationFrame\` after the HTML is inserted. In \`reset()\`, call \`echarts.getInstanceByDom(document.getElementById(id))?.dispose()\`.
- \`L\`: Leaflet 1.9.4 — use it to create interactive OSM maps. Always initialise the map inside \`requestAnimationFrame\` after the HTML is inserted. Always call \`map.remove()\` in \`reset()\`.
- \`console\`: Mocked console. Use \`console.log/info/warn/error\` for debugging. \`console.error\` signals a failure to the monitoring system.
- \`fetch\`: Proxied fetch — all requests are routed through the proxy. Only APIs listed in AVAILABLE EXTERNAL APIs may be called. Authentication and throttling are handled automatically.
- \`XLSX\`: xlsx-js-style library. Use it **only when the user explicitly asks for an Excel file**. Full cell styling is supported via the \`.s\` property (font, fill, border, alignment, number format). To trigger a download: \`XLSX.writeFile(wb, 'filename.xlsx')\`.
- \`jsPDF\`: jsPDF 2.x constructor. Use it **only when the user explicitly asks for a PDF file**. Create structured multi-page PDFs with text, shapes, images and tables. Page numbers: iterate pages and call \`doc.text('Page X / Y', x, y)\`. To download: \`doc.save('filename.pdf')\`.
${activeDatasetType === 'pdf' ? `- \`pdfData\`: Uint8Array — raw bytes of the active PDF document.
- \`pdfjsLib\`: PDF.js 3.x — use it to parse the PDF. Worker is disabled for sandbox compatibility (all parsing runs in the main thread).` : ''}
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
3. **Styling:** Use Tailwind CSS utility classes. Dark mode works automatically via \`dark:\` variants (e.g. \`bg-white dark:bg-gray-800\`). Prefer \`rounded-lg\`, \`shadow\`, \`p-4\`, \`text-sm\`, etc. over inline styles. Use \`h-full\` on the outermost wrapper \`div\` so it fills the panel — avoid fixed arbitrary heights like \`h-[750px]\`.
4. **Charts:** Use \`echarts\` (Apache ECharts 5). Generate a unique container ID with \`'chart-' + Date.now()\`. Set an explicit pixel height on the container div (e.g. \`style="height:260px"\`). Always initialise inside \`requestAnimationFrame(() => { const c = echarts.init(el, isDark ? 'dark' : null); c.setOption({...}); })\`. Detect dark mode with \`document.documentElement.classList.contains('dark')\`. In \`reset()\`, call \`echarts.getInstanceByDom(el)?.dispose()\`. Use gradients, rich tooltips, and animations freely — ECharts supports them natively.
5. **Error Handling:** Use \`try/catch\`. You MUST call \`console.error(error)\` inside the catch block — this is the primary failure signal. Return \`{ html: \\\`<div class="bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 p-3 rounded-lg text-sm">\\\${error.message}</div>\\\`, data: {}, reset: () => {} }\`.
6. **Diagnostic logging:** For any formula involving complex parsing (PDF, raw text) or multiple API calls, add \`console.log\` at key checkpoints: section detection, loop entry, object counts, and format validation. Example: \`console.log('section found, lines:', sectionLines.length)\` or \`console.log('rows extracted:', rows.length)\`. This lets the user immediately see which step diverged from the expected structure without having to re-run with added debug code.
7. **Safety & Validation:** Always verify that field values exist before operating on them. Handle missing/null/undefined values gracefully.
7. **No Inline JS:** Do not use \`onclick="..."\`. Use data-attributes and event listeners inside \`requestAnimationFrame(() => { ... })\`.
8. **Interactivity:** Use unique IDs or specific classes for event listeners to prevent collisions.
9. **Looping:** Prefer \`for...of\` over \`.forEach()\` — errors bubble correctly and async order is preserved.
10. **Column access:** Use bracket notation for column names with spaces: \`row['Column Name']\`.
11. **External calls:** \`fetch()\` is allowed only for APIs listed in AVAILABLE EXTERNAL APIs. All calls are proxied — do not add authentication headers yourself. Use \`await fetch(url)\` directly.
12. **Counting/grouping:** Use a plain object or \`Map\` to count and group values.
13. **Maps (Leaflet):** Use \`L\` (Leaflet 1.9.4 global). Pattern:
    - In \`html\`, include a container: \`<div id="\${mapId}" style="height:320px;border-radius:8px;overflow:hidden"></div>\`
    - In \`requestAnimationFrame\`, initialise: \`const map = L.map(mapId).setView([lat,lng], zoom)\` then add \`L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {attribution:'© OpenStreetMap contributors'}).addTo(map)\`
    - In \`reset()\`, always call \`map.remove()\`
    - Use \`L.marker([lat,lng]).addTo(map).bindPopup(label)\` for points; \`L.circle\`, \`L.polygon\`, etc. for shapes.
    - Always validate coordinates: skip rows where lat/lng are missing or non-numeric.`

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
The full document text is included in the conversation — use it to understand the content and structure.
In formulas: use \`pdfText\` (pre-extracted string) split by '\\n' to process line by line. Pages are separated by "## Page N" headers.
Do NOT use \`data\` (empty). \`pdfData\` + \`pdfjsLib\` are available for raw positional extraction if needed.

*EXTRACTION STRATEGY*:
Before writing any formula, read the pdfText carefully to understand: which sections exist, where the relevant table is, what the column headers are, and what a data row looks like vs. a header or subtotal row.

Then follow these principles:
1. **Navigate using static content only** — section titles, column headers, and category labels are identical across every instance of this document type. Use \`line.trim().startsWith('...')\` or \`line.includes('...')\` on those fixed strings to locate sections and identify row types. Never use dynamic values (amounts, names, dates) as navigation anchors, and never hardcode them in the formula.
2. **Two-pass algorithm** — first pass: iterate lines and classify each one (data row, category header, noise). Second pass: iterate the classified lines to extract structured data. This separation makes the logic clearer and avoids fragile one-pass heuristics.
3. **Ask when uncertain** — if the section title, column order, or row structure is ambiguous from the pdfText, ask the user for clarification before writing the formula. A wrong assumption wastes a round-trip. Example: "I can see columns [Description | Qty | Price | Total] — which values do you need?"

*DYNAMIC EXTRACTION ONLY*:
NEVER hardcode any number, name, date or amount read from the conversation into the formula. Every value in \`data\` and \`html\` must come from parsing \`pdfText\` at runtime.

*FORMAT REMINDER*:
\`pdfText\` uses \` | \` as the column separator (never plain spaces). Section detection: \`t.trim().startsWith('keyword')\` — never \`===\`, never \`&&\` across two keywords. Numbers: strip apostrophe thousands separators and percent signs before \`parseFloat\`.
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
  const html = \`<div class="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3"><p class="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">Distribution of \${col}</p><div id="\${chartId}" style="height:260px"></div></div>\`;
  requestAnimationFrame(() => { const el = document.getElementById(chartId); if (!el) return; const chart = echarts.init(el, isDark ? 'dark' : null); chart.setOption({ backgroundColor: 'transparent', tooltip: { trigger: 'axis' }, grid: { left: 16, right: 16, top: 16, bottom: 40, containLabel: true }, xAxis: { type: 'category', data: labels, axisLabel: { rotate: 30, fontSize: 11 } }, yAxis: { type: 'value' }, series: [{ type: 'bar', data: values, barMaxWidth: 48, itemStyle: { borderRadius: [4, 4, 0, 0], color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: '#6366f1' }, { offset: 1, color: '#818cf8' }]) } }] }); });
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
# REQUIRED PATTERN — Extract a table from pdfText (two-pass with hierarchy)
Adapt: section keywords, NOISE set, column end-offsets (-N), and the isDataRow test.
\`\`\`js
try {
  const parseNum = s => {
    if (!s) return NaN;
    return parseFloat(s.replace(/'/g, '').replace(/,/g, '.').replace(/%/g, '').trim());
  };

  // Static labels to skip — column headers and navigation text that repeat on every page.
  // Identify them by reading pdfText; they are always the same string across documents.
  const NOISE = new Set(['STATIC COLUMN HEADER 1', 'STATIC COLUMN HEADER 2']);

  // ── Pass 1: collect and classify lines inside the section ──────────────────
  const lines = [];
  let inSection = false;

  for (const raw of pdfText.split('\\n')) {
    const t = raw.trimEnd();
    if (!t.trim() || t.startsWith('## Page')) continue;

    // Use startsWith on the static section title — never === and never &&
    if (!inSection && t.trim().startsWith('SECTION TITLE'))      { inSection = true; continue; }
    if (inSection  && t.trim().startsWith('NEXT SECTION TITLE')) { inSection = false; break; }
    if (!inSection) continue;

    const cols  = t.trim().split(' | ');
    const label = cols[0].replace(/ \\(suite\\)$/, '').trim(); // strip " (suite)" continuations

    if (NOISE.has(label)) continue;

    // isDataRow  — first column starts with a digit or apostrophe (quantity-led rows)
    // isHeader   — no leading digit AND multiple columns (static category / sub-category label)
    // isTotal    — known static total label (adapt to your document)
    const isDataRow = /^[\\d']/.test(label);
    const isHeader  = !isDataRow && cols.length > 1;
    const isTotal   = label === 'Total' || label.startsWith('Total ');

    lines.push({ label, cols, isDataRow, isHeader, isTotal });
  }

  // ── Pass 2: build rows, tracking the 3-level hierarchy context ─────────────
  const rows = [];
  let path     = [];   // [level-1, level-2, level-3] — updated by header blocks
  let grandTotal = 0;

  for (let i = 0; i < lines.length; i++) {
    const { label, cols, isDataRow, isHeader, isTotal } = lines[i];

    if (isTotal) {
      // Grand total row — capture the summary value (adapt column index as needed)
      grandTotal = parseNum(cols[cols.length - 2]);
      continue;
    }

    if (isHeader) {
      // Consecutive headers form one context block defining the hierarchy level(s)
      const block = [label];
      while (i + 1 < lines.length && lines[i + 1].isHeader) block.push(lines[++i].label);
      // 2+ consecutive headers reset the full path; a single header updates the deepest level
      path = block.length >= 2 ? [...block] : [...path.slice(0, -1), label];
      continue;
    }

    if (isDataRow) {
      // First column combines quantity and name: e.g. "1'140 PICTET-ST MONEY MARKET EUR-I"
      const m = label.match(/^([\\d'][\\d'.]*) (.+)/);
      if (!m) continue;
      const qty = parseNum(m[1]);
      if (isNaN(qty)) continue;

      // End-counting: last columns are most stable when rows have varying widths.
      // Inspect the column header row in pdfText to map -N offsets to actual fields.
      const estimation = parseNum(cols.length > 4 ? cols[cols.length - 3] : cols[cols.length - 2]);
      const weight     = parseNum(cols[cols.length - 2]);
      const unrealized = parseNum(cols[cols.length - 1]);

      if (!isNaN(estimation)) {
        rows.push({
          category:  path[0] ?? '',
          subgroup:  path[1] ?? '',
          detail:    path[2] ?? '',
          name:      m[2].trim(),
          qty, estimation, weight, unrealized,
        });
      }
    }
  }

  if (!rows.length) throw new Error('No rows found — check section keywords and NOISE set');

  const html = \`
    <div class="space-y-3 font-sans">
      <div class="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div class="p-4 border-b border-gray-100 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/50 flex justify-between items-center">
          <h3 class="text-sm font-bold text-gray-900 dark:text-white uppercase tracking-tight">Extracted Table</h3>
          \${grandTotal ? \`<div class="text-right">
            <span class="text-[10px] text-gray-400 uppercase block">Total</span>
            <span class="text-sm font-black text-indigo-600">\${grandTotal.toLocaleString()}</span>
          </div>\` : \`<span class="text-xs text-gray-400">\${rows.length} rows</span>\`}
        </div>
        <div class="overflow-x-auto">
          <table class="min-w-full text-[11px] divide-y divide-gray-100 dark:divide-gray-700">
            <thead class="bg-gray-50 dark:bg-gray-900/80">
              <tr>
                <th class="px-4 py-3 text-left font-semibold text-gray-500 uppercase">Hierarchy / Name</th>
                <th class="px-4 py-3 text-right font-semibold text-gray-500 uppercase">Qty</th>
                <th class="px-4 py-3 text-right font-semibold text-gray-500 uppercase">Estimation</th>
                <th class="px-4 py-3 text-right font-semibold text-gray-500 uppercase">Weight</th>
                <th class="px-4 py-3 text-right font-semibold text-gray-500 uppercase">Unreal. %</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100 dark:divide-gray-700">
              \${rows.map(r => \`
                <tr class="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                  <td class="px-4 py-2.5">
                    <div class="flex flex-wrap items-center gap-1 mb-0.5">
                      \${r.category ? \`<span class="text-[8px] px-1.5 py-0.5 rounded font-bold uppercase bg-gray-100 dark:bg-gray-700 text-gray-500">\${r.category}</span>\` : ''}
                      \${r.subgroup ? \`<span class="text-[8px] font-bold text-indigo-400 uppercase">› \${r.subgroup}</span>\` : ''}
                      \${r.detail   ? \`<span class="text-[8px] font-bold text-emerald-500 uppercase">› \${r.detail}</span>\` : ''}
                    </div>
                    <div class="font-semibold text-gray-900 dark:text-gray-100">\${r.name}</div>
                  </td>
                  <td class="px-4 py-2.5 text-right font-mono text-gray-500">\${isNaN(r.qty) ? '—' : r.qty.toLocaleString()}</td>
                  <td class="px-4 py-2.5 text-right font-mono font-bold text-gray-900 dark:text-white">\${isNaN(r.estimation) ? '—' : r.estimation.toLocaleString()}</td>
                  <td class="px-4 py-2.5 text-right text-gray-500">\${isNaN(r.weight) ? '—' : r.weight.toFixed(1) + '%'}</td>
                  <td class="px-4 py-2.5 text-right \${r.unrealized > 0 ? 'text-emerald-600' : r.unrealized < 0 ? 'text-red-500' : 'text-gray-400'}">\${isNaN(r.unrealized) ? '—' : (r.unrealized > 0 ? '+' : '') + r.unrealized.toFixed(1) + '%'}</td>
                </tr>\`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>\`;

  return { html, data: { rows, grandTotal }, reset: () => {} };
} catch (error) {
  console.error(error);
  return { html: \`<div class="p-4 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 rounded-lg text-sm">\${error.message}</div>\`, data: {}, reset: () => {} };
}
\`\`\`` : ''

  return [role, outputFormat, answerRules, environment, refinementRules, codingRules, apisSection, dataContext, catalogExample, pdfExample, example, mapExample]
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
      if (inStr && c === '\n') { out += '\\n'; continue }
      if (inStr && c === '\r') { out += '\\r'; continue }
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

const DARK_CSS = `
html.dark body { background-color: ${darkVars['--background']}; color: ${darkVars['--foreground']}; }
`

const TAILWIND_CONFIG = `
tailwind.config = {
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        gray: {
          950: '${darkGray[950]}',
          900: '${darkGray[900]}',
          800: '${darkGray[800]}',
          700: '${darkGray[700]}',
          600: '${darkGray[600]}',
          500: '${darkGray[500]}',
          400: '${darkGray[400]}',
          300: '${darkGray[300]}',
          200: '${darkGray[200]}',
          100: '${darkGray[100]}',
          50:  '${darkGray[50]}',
        }
      }
    }
  }
}`

function buildSandboxDocumentFn(
  rows: Record<string, unknown>[],
  datasets: Record<string, Record<string, unknown>[]>,
  formula: string,
  darkMode: boolean,
  isPdf = false,
  pdfText = '',
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
<script src="https://cdn.tailwindcss.com"></script>
<script>${TAILWIND_CONFIG}</script>
<script src="https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css">
<script src="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
${isPdf ? '<script src="https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js"></script>' : ''}
<style>
html,body{margin:0;padding:0;height:100%;box-sizing:border-box}
body{padding:8px;font-family:system-ui,-apple-system,sans-serif}
#r{height:100%}
*{box-sizing:border-box}
${DARK_CSS}
</style>
</head>
<body>
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
function __runFormula() {
  (async () => {
    const data = ${dataJson};
    const datasets = ${datasetsJson};
    const mock = {
      log:   (...a) => parent.postMessage({ t: 'log',  m: a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ') }, '*'),
      info:  (...a) => parent.postMessage({ t: 'log',  m: a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ') }, '*'),
      warn:  (...a) => parent.postMessage({ t: 'warn', m: a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ') }, '*'),
      error: (...a) => parent.postMessage({ t: 'error',m: a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ') }, '*'),
    };
    const root = document.getElementById('r');
    try {
      const fn = new (Object.getPrototypeOf(async function(){}).constructor)('data', 'datasets', 'echarts', 'L', 'console', 'XLSX', 'jsPDF', 'pdfData', 'pdfjsLib', 'pdfText', ${formulaJson});
      const result = await fn(data, datasets, typeof echarts !== 'undefined' ? echarts : undefined, typeof L !== 'undefined' ? L : undefined, mock, typeof XLSX !== 'undefined' ? XLSX : undefined, window.jspdf ? window.jspdf.jsPDF : undefined, __pdfData, typeof pdfjsLib !== 'undefined' ? pdfjsLib : undefined, pdfText);
      if (result && result.html) root.innerHTML = result.html;
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
  private _pendingFormulaFeedback: string | null = null
  private _listeners: Map<string, Set<Function>> = new Map()
  private _iframe?: HTMLIFrameElement
  private _fetchListener?: (e: MessageEvent) => void

  constructor(config: LocalAssistantConfig) {
    this._config = { ...config }
    if (config.apiPreferences) this._apiPrefs = [...config.apiPreferences]
  }

  // -------------------------------------------------------------------------
  // Configuration getters / setters
  // -------------------------------------------------------------------------

  get llm(): LLMConfig { return { ...this._config.llm } }
  set llm(v: LLMConfig) { this._config.llm = { ...v }; this._emit('llm:change', { ...this._config.llm }) }

  /** Encrypt a plain Gemini API key via the proxy and store it. Emits 'llm:change'. */
  async setLlmApiKey(plainKey: string): Promise<void> {
    const encrypted = this._config.proxy.isEncrypted(plainKey)
      ? plainKey
      : await this._config.proxy.encryptMessage(plainKey)
    this._config.llm = { ...this._config.llm, apiKey: encrypted }
    this._emit('llm:change', { ...this._config.llm })
  }

  /** Access the proxy client (e.g. for manual encrypt/decrypt or session checks). */
  get proxy(): ProxyClient { return this._config.proxy }

  get darkMode(): boolean { return this._config.darkMode ?? false }
  set darkMode(v: boolean) { this._config.darkMode = v }

  get resultContainer(): ResultContainer | undefined { return this._config.resultContainer }
  set resultContainer(v: ResultContainer) { this._config.resultContainer = v }

  get sandboxPermissions(): string[] { return this._config.sandboxPermissions ?? DEFAULT_SANDBOX_PERMISSIONS }
  set sandboxPermissions(v: string[]) { this._config.sandboxPermissions = v }

  // -------------------------------------------------------------------------
  // Dataset management
  // -------------------------------------------------------------------------

  addDataset(name: string, rows: Record<string, unknown>[]): void {
    this._datasets.set(name, { type: 'table', rows })
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

  updateDataset(name: string, rows: Record<string, unknown>[]): void {
    if (this._datasets.has(name)) {
      this._datasets.set(name, { type: 'table', rows })
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
      const res = await fetch(`${this._config.proxy.baseUrl}/common/api-config`, {
        headers: this._authHeaders(),
      })
      if (!res.ok) return []
      this._apiConfigs = await res.json()
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
    const systemPrompt = buildSystemPromptFn(
      active?.columns ?? [],
      active?.rows ?? [],
      this.getDatasets(),
      this.getActivatedApis(),
      active?.type ?? 'table',
      this._activeDatasetName,
      this.getActivePdfExtractedText(),
      this.getActivePdfPageCount(),
      opts?.exampleAnalysis ?? null,
    )
    this._lastSystemPrompt = systemPrompt

    // For PDF datasets: inject the full extracted text into the first user message so
    // the LLM has complete document context. Reset history when switching to a different PDF.
    let llmMessage = userMessage
    if (active?.type === 'pdf') {
      const pdfText = this.getActivePdfExtractedText()
      const differentPdfInHistory = this._history.some(
        t => t.role === 'user' &&
          t.parts[0]?.text?.startsWith('[PDF:') &&
          !t.parts[0]?.text?.startsWith(`[PDF: "${active.name}"`)
      )
      if (differentPdfInHistory) {
        this._history = []
        this._emit('history:reset')
      }
      const alreadyInjected = this._history.some(
        t => t.role === 'user' && t.parts[0]?.text?.includes(`[PDF: "${active.name}"`)
      )
      if (pdfText && !alreadyInjected) {
        const MAX_CHARS = 400_000  // ~100K tokens — within Gemini's context window
        const truncated = pdfText.length > MAX_CHARS
          ? pdfText.slice(0, MAX_CHARS) + '\n\n[... document truncated due to length ...]'
          : pdfText
        llmMessage = `[PDF: "${active.name}" — ${this.getActivePdfPageCount()} pages]\n\n${truncated}\n\n[User question]\n${userMessage}`
      }
    }

    // Prepend execution feedback from the previous formula run
    if (this._pendingFormulaFeedback) {
      llmMessage = `${this._pendingFormulaFeedback}\n\n[User follow-up]\n${llmMessage}`
      this._pendingFormulaFeedback = null
    }

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

    const res = await fetch(`${this._config.proxy.baseUrl}/common/genai`, {
      method: 'POST',
      headers: this._authHeaders(),
      body: JSON.stringify({
        encryptedApiKey: this._config.llm.apiKey ?? '',
        model: this._config.llm.model ?? 'gemini-3-flash-preview',
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [
          ...this._history,
          { role: 'user', parts: [{ text: llmMessage }] },
        ],
        generation_config: {
          thinking_config: { thinking_level: 'high', include_thoughts: true },
          temperature: 0.7,
        },
      }),
    })

    if (!res.ok) {
      let detail = res.statusText
      try {
        const err = await res.json()
        detail = err.error?.message ?? err.error ?? detail
        if (typeof detail === 'object') detail = JSON.stringify(detail)
      } catch { /* ignore */ }
      throw new Error(`Gemini [${res.status}]: ${detail}`)
    }

    const data = await res.json()
    const parts: Array<{ text?: string; thought?: boolean }> =
      data.candidates?.[0]?.content?.parts ?? []

    if (!parts.length) throw new Error('Gemini returned an empty response')

    let reasoning = ''; let formula = ''; let answer = ''; let title = ''; let description = ''
    let dependencies: AnalysisDependencies | undefined

    for (const part of parts) {
      if (part.thought === true) continue
      if (!part.text) continue

      const parsed = tryParseJson(part.text)
      if (parsed) {
        if (parsed.answer || parsed.formula || parsed.reasoning) {
          reasoning    = String(parsed.reasoning   ?? reasoning)
          formula      = String(parsed.formula     ?? formula)
          answer       = String(parsed.answer      ?? answer)
          title        = String(parsed.title       ?? title)
          description  = String(parsed.description ?? description)
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
        }
        continue
      }
      if (part.text.trimStart().startsWith('{') || part.text.trimStart().startsWith('[')) continue
      if (!answer) answer = part.text.trim()
    }

    // Append to conversation history — store llmMessage so PDF context persists across turns
    this._history = [
      ...this._history,
      { role: 'user',  parts: [{ text: llmMessage }] },
      { role: 'model', parts: [{ text: JSON.stringify({ answer, formula, title, description, dependencies }) }] },
    ]

    const response: AssistantResponse = {
      answer: answer || reasoning,
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

    const proxyUrl = new URL(`${this._config.proxy.baseUrl}/common/api-proxy`)
    proxyUrl.searchParams.set('url', url)

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

    let res: Response
    try {
      res = await fetch(proxyUrl.toString(), {
        method: opts.method || 'GET',
        headers: { ...headers, 'X-Proxy-Token': `Bearer ${this._config.proxy.token ?? ''}` },
        body: opts.body || undefined,
      })
    } catch (err) {
      emitIfUnmatched()
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

  private _authHeaders(): Record<string, string> {
    const token = this._config.proxy.token
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }
  }

  private _emit(event: string, ...args: unknown[]): void {
    this._listeners.get(event)?.forEach(fn => {
      try { fn(...args) } catch { /* don't let listener errors propagate */ }
    })
  }
}
