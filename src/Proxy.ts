import type { ApiConfig, CrmObjectType } from './types'

/** Payload sent to the genai endpoint — matches what LocalAssistant constructs. */
export interface GenaiPayload {
  encryptedApiKey: string
  model: string
  system_instruction: { parts: Array<{ text: string }> }
  contents: unknown[]
  generation_config?: unknown
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

  /** Send a prompt to the configured LLM and return the raw fetch Response. */
  callGenai(payload: GenaiPayload): Promise<Response>

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
