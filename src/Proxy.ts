import type { ApiConfig, CrmObjectType } from './types'

/** API protocol used to reach the LLM. 'openai' covers any OpenAI-compatible endpoint. */
export type LLMProtocol = 'gemini' | 'openai' | 'anthropic'

/**
 * A binary attachment (image, PDF, …) sent alongside a message.
 * Only used by the "send to AI" path — never produced in safe mode.
 */
export interface LLMAttachment {
  /** Original file name (for display / provider filename hints). */
  name: string
  /** MIME type, e.g. 'image/png' or 'application/pdf'. */
  mimeType: string
  /** Base64-encoded file contents, WITHOUT the `data:` URI prefix. */
  data: string
}

export interface LLMMessage {
  role: 'user' | 'assistant'
  content: string
  /**
   * Machine-generated preamble for this turn (e.g. a previous run's execution
   * trace). The proxy prepends it to `content` when forwarding to the model, but
   * does NOT count it against the per-message prompt-char limit — that limit is
   * meant to bound the user's own input (`content`), not generated context.
   */
  context?: string
  /**
   * Files attached to this message. The proxy maps them into each provider's
   * multimodal format. Rejected with HTTP 403 when the proxy runs in safe mode.
   */
  attachments?: LLMAttachment[]
}

/** What the client sends to the proxy for an LLM call. */
export interface LLMRequest {
  /**
   * Reference a server-configured model by id (ProxyClient).
   * When set, the server resolves protocol/model/apiKey/baseUrl from its config.
   */
  modelId?: string
  /** API protocol for direct/BYOK calls. Required when not using modelId. */
  protocol?: LLMProtocol
  /** Model identifier. Falls back to protocol default if omitted. */
  model?: string
  /**
   * API key. Plain text for LocalProxy, encrypted via encryptMessage() for ProxyClient.
   * Omit when using a server-managed modelId and the key lives server-side.
   */
  apiKey?: string
  /**
   * Override the protocol's default API endpoint.
   * Used by LocalProxy only — ProxyClient ignores this (endpoint is server-side config).
   */
  baseUrl?: string
  /** Plain-text system prompt. */
  system: string
  /** Conversation messages in chronological order. */
  messages: LLMMessage[]
  options?: {
    temperature?: number
    /** Request JSON-formatted output. */
    json?: boolean
    /** Enable extended thinking / chain-of-thought where supported. */
    thinking?: boolean
  }
}

/** Normalised LLM response returned by all proxy implementations. */
export interface LLMResponse {
  /** The model's answer (thoughts already stripped). */
  text: string
  /** Extended thinking / reasoning trace, if the model produced one. */
  thoughts?: string
}

/** Proxy-level public policy, from `GET /public/config` (no auth required). */
export interface PublicConfig {
  /** When true, the proxy never forwards attachments to the LLM. */
  safeMode: boolean
  publicSessions?: {
    enabled: boolean
    rateLimits?: {
      /** Max AI (genai) requests per IP per day for public/guest sessions. */
      genaiPerIpPerDay?: number
      /** Max API-proxy requests per IP per day for public/guest sessions. */
      apiPerIpPerDay?: number
    }
  }
}

/** Model descriptor returned by getAvailableLLMs() — no keys or internal URLs. */
export interface LLMModelInfo {
  /** Stable identifier used in LLMRequest.modelId. */
  id: string
  /** Human-readable label for display in the UI. */
  displayName: string
  protocol: LLMProtocol
  model: string
  isDefault?: boolean
  /**
   * Capability tier, from `llm-configs.json`. Lets the client pick prompt
   * verbosity: 'small' = local/edge (leaner prompt); 'medium'/'large' (the
   * default when unset) = full prompt.
   */
  size?: 'small' | 'medium' | 'large'
}

/**
 * Abstraction over the LocalFlow proxy — implemented by ProxyClient (real server)
 * and LocalProxy (browser-side standalone, no server required).
 */
export interface Proxy {
  /** Session token; null when not authenticated. */
  token: string | null

  isConnected(): boolean

  /** Authenticate and store a session token. */
  connect(type?: string, config?: Record<string, unknown>): Promise<void>

  /** Returns session metadata for the current token. */
  getSessionInfo(): Promise<unknown>

  /** Returns true if the string is already in the proxy-encrypted format. */
  isEncrypted(str: string): boolean

  /** Encrypt a plaintext string (via server or local no-op). */
  encryptMessage(message: string): Promise<string>

  /** Decrypt a previously encrypted string. */
  decryptMessage(message: string): Promise<string>

  /** Send a prompt to the configured LLM and return a normalised response. */
  callLLM(request: LLMRequest): Promise<LLMResponse>

  /**
   * Return the list of LLM models available on this proxy.
   * API keys and internal URLs are never included.
   * Returns [] for LocalProxy (user configures the model directly).
   */
  getAvailableLLMs(): Promise<LLMModelInfo[]>

  /** Fetch available API configurations. */
  getApiConfigs(): Promise<ApiConfig[]>

  /**
   * Proxy an API fetch on behalf of the sandbox iframe.
   * The server proxy injects auth; LocalProxy forwards directly (CORS-dependent).
   */
  proxyApiCall(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | null,
  ): Promise<Response>

  /** Extract text from a PDF. Not available in local mode. */
  extractPdf(
    buffer: ArrayBuffer,
    searchString?: string,
  ): Promise<{ text: string; pageCount: number }>

  /** List CRM object types. */
  listObjectTypes(): Promise<CrmObjectType[]>

  /** Fetch full metadata for one CRM object type. */
  getObjectMetadata(objectType: string): Promise<CrmObjectType>

  /** Fetch rows for a CRM object type. */
  getData(objectType: string, fields: string[]): Promise<Record<string, unknown>[]>
}
