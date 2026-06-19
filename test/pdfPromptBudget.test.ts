import { describe, it, expect } from 'vitest'
import { LocalAssistant } from '../src/LocalAssistant'
import type { LLMRequest } from '../src/Proxy'

// ---------------------------------------------------------------------------
// PDF document text must travel in the `system` prompt, NOT in the user message
// content. The proxy's per-message prompt-char limit (maxPromptChars) counts
// message content only — the PDF is bounded by the upload-size limit at
// extraction time. Regression guard for the "Message exceeds the N-character
// limit" failure when analysing a PDF larger than maxPromptChars.
// ---------------------------------------------------------------------------

function captureRequest() {
  let captured: LLMRequest | null = null
  const proxy = {
    callLLM: async (req: LLMRequest) => { captured = req; throw new Error('STOP') },
    isEncrypted: () => true,
    encryptMessage: async (s: string) => s,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
  return { proxy, get: () => captured }
}

describe('PDF prompt budgeting', () => {
  it('puts the document text in system, not in counted message content', async () => {
    const { proxy, get } = captureRequest()
    const a = new LocalAssistant({ proxy, llm: { modelId: 'm', protocol: 'gemini' } as never })

    // Far exceeds a typical maxPromptChars (e.g. 50000).
    const body = 'AIR LIQUIDE | FR0000120073 | 1,52% | 248,000000 | 176,54 EUR\n'.repeat(2000)
    const pdfText = `## Page 1\n${body}`
    expect(pdfText.length).toBeGreaterThan(50000)

    a.addPdfDataset('statement.pdf', new ArrayBuffer(8), pdfText, 3)
    a.setActiveDataset('statement.pdf')

    await expect(a.prompt('Quelle est la valorisation totale ?')).rejects.toThrow('STOP')

    const req = get()!
    // Document is in the system prompt…
    expect(req.system).toContain('# PDF DOCUMENT TEXT')
    expect(req.system).toContain('AIR LIQUIDE | FR0000120073')
    // …and absent from every message's content (what maxPromptChars counts).
    const msgChars = req.messages.reduce((n, m) => n + (m.content?.length ?? 0), 0)
    expect(req.messages.some(m => (m.content ?? '').includes('AIR LIQUIDE | FR0000120073'))).toBe(false)
    expect(req.messages.at(-1)!.content).toBe('Quelle est la valorisation totale ?')
    expect(msgChars).toBeLessThan(1000)
  })
})
