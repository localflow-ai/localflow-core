// Authorization vocabulary — the single source of truth shared by the proxy
// (which enforces) and the apps (which gate UI). See the proxy's
// docs/permissions.md for the full model. Deny-by-default everywhere.

/** A grantable capability. Absent from the effective set ⇒ denied. */
export type Capability =
  | 'ai.use'             // call the LLM at all (chat + analysis generation)
  | 'ai.attachImage'     // include images in an LLM call
  | 'ai.attachFile'      // send other raw files to the LLM ("send to AI")
  | 'ai.byok'            // supply your own LLM API key
  | 'pdf.extract'        // extract a PDF's text via the proxy (prereq for PDF analysis)
  | 'api.use'            // let analyses call external APIs via the proxy
  | 'crm.read'           // read CRM/ERP data via the proxy connectors
  | 'data.uploadTabular' // load CSV/Excel locally (advisory)
  | 'data.uploadOther'   // load other local files (advisory)
  | 'analysis.runLocal'  // run a saved analysis on local data, no LLM (advisory)
  | 'analysis.share'     // export/share an analysis to a file (advisory)
  | 'chat.paste'         // allow pasting into the chat input (advisory)

/** Numeric limits. `null` means unlimited. */
export interface PermissionLimits {
  maxPromptChars: number | null
  maxUploadBytes: number | null
  genaiPerDay: number | null
  apiPerDay: number | null
}

/** The resolved set the proxy serves from `GET /permissions`. */
export interface EffectivePermissions {
  capabilities: Capability[]
  limits: PermissionLimits
  /** Allowed LLM model ids, or `['*']` for all. */
  models: string[]
  /** Allowed external-API ids, or `['*']` for all. */
  apis: string[]
}

/** Fail-closed default: nothing allowed. Used on a genuine error fetching permissions. */
export const DENY_ALL: EffectivePermissions = {
  capabilities: [],
  limits: { maxPromptChars: 0, maxUploadBytes: 0, genaiPerDay: 0, apiPerDay: 0 },
  models: [],
  apis: [],
}

const ALL_CAPABILITIES: Capability[] = [
  'ai.use', 'ai.attachImage', 'ai.attachFile', 'ai.byok', 'pdf.extract',
  'api.use', 'crm.read', 'data.uploadTabular', 'data.uploadOther',
  'analysis.runLocal', 'analysis.share', 'chat.paste',
]

/**
 * Everything allowed. Used when the proxy doesn't implement permissions at all
 * (legacy / 404) — equivalent to the proxy's own "no permissions.json" behavior.
 * Client gating is UX only (the proxy enforces), so this never weakens security.
 */
export const ALLOW_ALL: EffectivePermissions = {
  capabilities: [...ALL_CAPABILITIES],
  limits: { maxPromptChars: null, maxUploadBytes: null, genaiPerDay: null, apiPerDay: null },
  models: ['*'],
  apis: ['*'],
}

export function can(p: EffectivePermissions | null | undefined, cap: Capability): boolean {
  return !!p && p.capabilities.includes(cap)
}

export function isModelAllowed(p: EffectivePermissions | null | undefined, modelId: string): boolean {
  return !!p && (p.models.includes('*') || p.models.includes(modelId))
}

export function isApiAllowed(p: EffectivePermissions | null | undefined, apiId: string): boolean {
  return !!p && (p.apis.includes('*') || p.apis.includes(apiId))
}
