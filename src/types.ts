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

import type { ProxyClient } from './ProxyClient'

/**
 * Where the assistant renders formula results.
 * Accepts an HTMLElement, a CSS selector string, or a function returning one.
 */
export type ResultContainer = HTMLElement | string | (() => HTMLElement | null)

export interface LocalAssistantConfig {
  /** Authenticated proxy client — created via `new ProxyClient(url)` then `await proxy.connect(...)`. */
  proxy: ProxyClient
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
}

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

export interface DatasetEntry {
  name: string
  rows: Record<string, unknown>[]
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
