// ---------------------------------------------------------------------------
// LLM configuration — extensible to support backends beyond Gemini
// ---------------------------------------------------------------------------

export type LLMType = 'gemini' | string

export interface LLMConfig {
  type: LLMType
  /** Encrypted API key (handled by the proxy) */
  apiKey?: string
  /** Model identifier. Defaults to 'gemini-3-flash-preview' for Gemini. */
  model?: string
}

// ---------------------------------------------------------------------------
// Component configuration
// ---------------------------------------------------------------------------

import type { Proxy } from './Proxy'

/**
 * Where the assistant renders formula results.
 * Accepts an HTMLElement, a CSS selector string, or a function returning one.
 */
export type ResultContainer = HTMLElement | string | (() => HTMLElement | null)

export interface LocalAssistantConfig {
  /** Proxy instance — use ProxyClient for a real server or LocalProxy for standalone/dev mode. */
  proxy: Proxy
  llm: LLMConfig
  darkMode?: boolean
  /**
   * Previously persisted API preferences (enabled flags + encrypted BYOK keys).
   * Pass the value you stored from the 'prefs:change' event to restore state across sessions.
   */
  apiPreferences?: ApiPreference[]
  /**
   * Container where formula results are rendered. Accepts an HTMLElement,
   * a CSS selector string, or a function returning one dynamically.
   * When set, prompt() auto-executes the returned formula in this container.
   */
  resultContainer?: ResultContainer
  /**
   * iframe sandbox permissions. Defaults to a safe standard set.
   * Override only if your use case requires additional capabilities.
   */
  sandboxPermissions?: string[]
  /**
   * When true, the first formula generated for a new PDF is silently executed,
   * its logs are collected, and a second LLM call revises the formula before
   * anything is shown to the user. Disabled by default.
   */
  pdfFormulaRevision?: boolean
  /**
   * Maximum number of silent LLM retries when a generated formula has a JavaScript
   * syntax error. The error is sent back to the LLM transparently — the user sees
   * no indication that a retry happened. Set to 0 to disable. Defaults to 1.
   */
  formulaHealingRetries?: number
  /**
   * Tailwind theme object injected into the sandbox Tailwind CDN config.
   * Accepts a standard Tailwind `theme` object (the value of `theme:` in `tailwind.config.js`).
   * Use it to align the sandbox palette with your host app's design tokens — e.g. override
   * `gray` shades or define a `primary` color that generated formulas can reference via
   * `bg-primary`, `text-primary`, `border-primary`, etc.
   *
   * @example
   * sandboxTheme: {
   *   extend: {
   *     colors: {
   *       primary: '#14b8a6',
   *       gray: { 700: '#1e2a29', 800: '#162120', 900: '#0d1a19' },
   *     },
   *   },
   * }
   */
  sandboxTheme?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

export interface DatasetEntry {
  name: string
  rows: object[]
  columns: string[]
}

// ---------------------------------------------------------------------------
// External APIs (mirror of proxyClient types — kept independent)
// ---------------------------------------------------------------------------

export interface ApiConfig {
  id: string
  name: string
  topic?: string
  baseUrl: string | string[]
  prompt?: string
  force?: boolean
  prepaid?: boolean
  apiKeyQueryParam?: string
  apiKeyQueryParamGetOnly?: string
  apiKeyHeader?: string
  apiKeyRoutePlaceholder?: string
  apiKeyBodyParam?: string
}

export interface ApiPreference {
  id: string
  enabled: boolean
  encryptedUserKey?: string
}

export interface ActivatedApi {
  config: ApiConfig
  encryptedUserKey?: string
}

/** Returns true if the API config supports a user-supplied key (BYOK). */
export function hasApiKey(config: ApiConfig): boolean {
  return !!(
    config.apiKeyQueryParam ||
    config.apiKeyQueryParamGetOnly ||
    config.apiKeyHeader ||
    config.apiKeyRoutePlaceholder ||
    config.apiKeyBodyParam
  )
}

// ---------------------------------------------------------------------------
// CRM
// ---------------------------------------------------------------------------

export interface CrmField {
  name: string
  label: string
  type: string
}

export interface CrmObjectType {
  name: string
  label: string
  layoutable?: boolean
  fields?: CrmField[]
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

export interface ConversationTurn {
  role: 'user' | 'model'
  parts: Array<{ text: string }>
}

export interface AnalysisDependencies {
  data: string[]
  datasets: Record<string, string[]>
}

/** What the LLM returns after parsing, including a snapshot of the system prompt used. */
export interface AssistantResponse {
  answer: string
  formula: string
  title?: string
  description?: string
  dependencies?: AnalysisDependencies
  /** Snapshot of the system prompt that produced this response. */
  systemPrompt?: string
}

// ---------------------------------------------------------------------------
// Analysis match hook
// ---------------------------------------------------------------------------

export interface AnalysisSuggestion {
  formula: string
  title?: string
  description?: string
  answer?: string
  dependencies?: AnalysisDependencies
}

export interface AnalysisMatchContext {
  history: ConversationTurn[]
  datasets: Record<string, Record<string, unknown>[]>
  activeDatasetName: string | null
  activeColumns: string[]
}

export interface AnalysisMatchResult {
  analysis: AnalysisSuggestion
  score: number
}

/**
 * Hook registered by the host to find the catalog analysis most relevant to
 * the current user intent. Return null if no suitable match exists.
 */
export type AnalysisMatchHook = (
  query: string,
  context: AnalysisMatchContext,
) => Promise<AnalysisMatchResult | null>

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Listener for LLM message responses emitted by LocalAssistant. */
export type MessageListener = (response: AssistantResponse) => void

/** Structured payload emitted by LocalAssistant on 'data:api-proxy' events.
 *  Fired for every formula fetch routed through the proxy — success and failure.
 *  Contains categorical data only — no human-readable text or i18n strings. */
export interface ApiProxyPayload {
  url: string             // full URL called (including query params)
  method: string          // HTTP method
  body: string | null     // raw request body sent (what left the browser)
  apiConfig: ApiConfig | null  // matched API definition; null if URL was unrecognised
  status?: number         // HTTP response status; undefined on network error
}

/** Structured payload emitted by LocalAssistant on 'data:llm' events.
 *  Contains categorical data only — no human-readable text or i18n strings. */
export type LlmDataPayload =
  | { kind: 'table'; query: string; dataset: string; columns: number }
  | { kind: 'pdf';   query: string; dataset: string; pages: number   }
  | { kind: 'text';  query: string; dataset: string                  }
