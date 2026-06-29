// Column / number parsing helpers made available to sandbox formulas.
//
// These are injected into the sandbox document via Function.prototype.toString()
// (see LocalAssistant `buildSandboxDocumentFn`), so they must be self-contained
// named function declarations with no references to module scope. Defining them
// here — as real, exported functions — keeps them unit-testable and avoids the
// backslash-cooking pitfalls of authoring regexes inside a template literal.
//
// French/Swiss number formats: thousands separators are space, non-breaking
// space ( ), narrow no-break space ( ) or apostrophe; the decimal
// separator is a comma. `\s` already covers the space variants in a JS regex.

/** Parse a monetary column value. Returns NaN for anything that isn't a clean amount. */
export function parseMoney(s: unknown): number {
  try {
    if (s === null || s === undefined || s === '') return NaN;
    if (typeof s === 'number') return isFinite(s) ? s : NaN;
    const str = String(s).trim();
    if (str.indexOf('/') !== -1) return NaN;                      // dates, fractions, references
    const sign = str.charAt(0) === '-' ? -1 : 1;
    const clean = str
      .replace(/^[+-]/, '')                                       // leading sign
      .replace(/[€$£₹¥¤*†‡°]/g, '')                                 // currency symbols anywhere (¤ = euro mis-encoded as Latin-1 0xA4)
      .replace(/\s*[A-Za-z]{1,4}\.?\s*$/, '')                     // trailing unit/currency code (EUR, CHF, UNT, F.)
      .trim();
    if (/[A-Za-z]/.test(clean)) return NaN;                       // residual letters → description/code, not money
    const norm = clean.replace(/[\s']/g, '').replace(/,/g, '.');  // drop thousands separators; decimal comma → dot
    if (!/^\d*\.?\d+$/.test(norm)) return NaN;                    // must reduce to a bare number
    if (norm.split('.')[0].length >= 10) return NaN;              // long unbroken integer → account/reference, not an amount
    const v = parseFloat(norm);
    return isNaN(v) ? NaN : sign * v;
  } catch {
    return NaN;
  }
}

/** Parse a non-monetary numeric column value (quantities, prices, percentages). */
export function parseNum(s: unknown): number {
  try {
    if (s === null || s === undefined || s === '') return NaN;
    if (typeof s === 'number') return isFinite(s) ? s : NaN;
    // Drop thousands separators (space variants + apostrophe), decimal comma → dot.
    // A trailing unit (UNT, %, …) is ignored by parseFloat.
    return parseFloat(String(s).replace(/[\s']/g, '').replace(/,/g, '.'));
  } catch {
    return NaN;
  }
}

/** Split a pipe-separated pdfText line into trimmed column strings. */
export function splitCols(s: unknown): string[] {
  return String(s ?? '').split('|').map(function (c) { return c.trim(); });
}
