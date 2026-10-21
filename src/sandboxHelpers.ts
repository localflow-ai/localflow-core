// Column / number parsing helpers made available to sandbox formulas.
//
// These are injected into the sandbox document via Function.prototype.toString()
// (see LocalAssistant `buildSandboxDocumentFn`), so they must be self-contained
// named function declarations with no references to module scope. Defining them
// here — as real, exported functions — keeps them unit-testable and avoids the
// backslash-cooking pitfalls of authoring regexes inside a template literal.
//
// Number formats: UNIVERSAL across occidental conventions — the source locale
// is unknown and varies per document (extracted PDFs, Excel display strings):
//
//   FR/BE   1 234,56    (space-family thousands, decimal comma)
//   CH      1'234.56    (apostrophe thousands, decimal dot)
//   DE/ES/IT 1.234,56   (dot thousands, decimal comma)
//   US/UK   1,234.56    (comma thousands, decimal dot)
//
// Resolution is structural, not locale-based:
//   1. Space-family (incl. NBSP variants) and apostrophes are always thousands.
//   2. When both ',' and '.' appear, the LAST one is the decimal separator.
//   3. A separator appearing several times is a thousands separator.
//   4. A single ',' or '.' is a decimal separator — except the one genuinely
//      ambiguous shape, exactly three trailing digits ("1,234"): quantities
//      keep the decimal reading (3-decimal unit counts are real: 751,169 UNT),
//      while parseMoney reads thousands (no occidental currency displays three
//      decimals, so "1,234 €" is 1234).
//   5. DOCUMENT CALIBRATION overrides rule 4: when the surrounding document
//      proves its convention (detectNumberFormat() finds unambiguous
//      two-separator numbers like "101,247.86" or "1.234,56"), BOTH parsers
//      follow it on the ambiguous shape — a US statement's "1,138" quantity is
//      1138 shares, a FR statement's "11,014" is 11.014 fund units. The sandbox
//      sets the global __numberFormat from the active pdfText; headless runners
//      can set globalThis.__numberFormat = detectNumberFormat(text) themselves.
//      Without evidence (null), rule 4 applies unchanged.
// Percent/permille signs are stripped in parseNum (value stays as displayed:
// "2,23 %" → 2.23 — scaling is the formula's business); parseMoney still
// rejects them (a percentage is not an amount).

// Document-level calibration channel (rule 5). Set by the sandbox bootstrap
// (from the active pdfText) or by a headless runner; absent = uncalibrated.
declare global {
  // eslint-disable-next-line no-var
  var __numberFormat: 'us' | 'eu' | null | undefined
}

/**
 * Detect a document's number convention from unambiguous evidence (numbers
 * carrying BOTH a thousands separator and a decimal part). Returns 'us'
 * (comma/apostrophe/space thousands + dot decimal), 'eu' (dot/apostrophe/space
 * thousands + comma decimal), or null when the text proves neither.
 * Self-contained (injected into the sandbox via toString()).
 */
export function detectNumberFormat(text: unknown): 'us' | 'eu' | null {
  try {
    var t = String(text || '');
    var us =
      (t.match(/\d,\d{3}\.\d/g) || []).length +                     // 1,234.56
      (t.match(/\d,\d{3},\d{3}/g) || []).length +                   // 1,234,567
      (t.match(/\d['’]\d{3}\.\d/g) || []).length +             // 1'234.56 (CH)
      (t.match(/\d[\u0020\u00a0\u202f\u2009]\d{3}\.\d/g) || []).length; // 1 234.56
    var eu =
      (t.match(/\d\.\d{3},\d/g) || []).length +                     // 1.234,56
      (t.match(/\d\.\d{3}\.\d{3}/g) || []).length +                 // 1.234.567
      (t.match(/\d['’]\d{3},\d/g) || []).length +             // 1'234,56
      (t.match(/\d[\u0020\u00a0\u202f\u2009]\d{3},\d/g) || []).length; // 1 234,56 (FR)
    if (us > eu) return 'us';
    if (eu > us) return 'eu';
    return null;
  } catch {
    return null;
  }
}

/** Parse a monetary column value. Returns NaN for anything that isn't a clean amount. */
export function parseMoney(s: unknown): number {
  try {
    if (s === null || s === undefined || s === '') return NaN;
    if (typeof s === 'number') return isFinite(s) ? s : NaN;
    var str = String(s).trim();
    if (str.indexOf('/') !== -1) return NaN;                      // dates, fractions, references
    var sign = 1;
    if (/^\(.*\)$/.test(str)) { sign = -1; str = str.slice(1, -1).trim(); }  // accounting negative (1 234,56)
    if (/^[+-]/.test(str)) { if (str.charAt(0) === '-') sign = -sign; str = str.slice(1).trim(); }
    str = str
      .replace(/[€$£₹¥¤*†‡°•]/g, '')                              // currency symbols + marker glyphs anywhere (¤ = euro mis-encoded as Latin-1 0xA4; • = neutralized symbol-font marker)
      .replace(/^[A-Za-z]{1,4}\.?\s+/, '')                        // leading currency code (EUR 1 234,56)
      .replace(/\s*[A-Za-z]{1,4}\.?\s*$/, '')                     // trailing unit/currency code (EUR, CHF, UNT, F.)
      .trim();
    if (/[A-Za-z]/.test(str)) return NaN;                         // residual letters → description/code, not money
    var norm = str.replace(/[\s'’]/g, '');                        // space-family + apostrophes: always thousands
    var lastComma = norm.lastIndexOf(',');
    var lastDot = norm.lastIndexOf('.');
    var num;
    if (lastComma !== -1 && lastDot !== -1) {
      num = lastComma > lastDot
        ? norm.replace(/\./g, '').replace(/,/g, '.')              // 1.234.567,89 (EU)
        : norm.replace(/,/g, '');                                 // 1,234,567.89 (US)
    } else if (lastComma !== -1 || lastDot !== -1) {
      var sep = lastComma !== -1 ? ',' : '.';
      var parts = norm.split(sep);
      var fmt = typeof __numberFormat !== 'undefined' ? __numberFormat : null;
      var thousandsShape = parts.length === 2 && parts[1].length === 3 && parts[0].length >= 1 && parts[0].length <= 3 && parts[0].charAt(0) !== '0';
      if (parts.length > 2) {
        num = parts.join('');                                     // 1,234,567 / 1.234.567 → thousands
      } else if (thousandsShape && fmt !== null) {
        // Document calibration (rule 5): follow the PROVEN convention.
        num = (fmt === 'us') === (sep === ',') ? parts[0] + parts[1] : parts[0] + '.' + parts[1];
      } else if (thousandsShape) {
        num = parts[0] + parts[1];                                // money bias: "1,234" / "1.234" → 1234
      } else {
        num = parts[0] + '.' + parts[1];                          // decimal
      }
    } else {
      num = norm;
    }
    if (!/^\d*\.?\d+$/.test(num)) return NaN;                     // must reduce to a bare number
    if (num.split('.')[0].length >= 10) return NaN;               // long unbroken integer → account/reference, not an amount
    var v = parseFloat(num);
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
    var str = String(s).trim();
    var sign = 1;
    if (/^[+-]/.test(str)) { sign = str.charAt(0) === '-' ? -1 : 1; str = str.slice(1).trim(); }
    str = str
      .replace(/[%‰•]/g, '')                                      // percent signs + marker glyphs — value stays as displayed
      .replace(/\s*[A-Za-z]{1,4}\.?\s*$/, '')                     // trailing unit code (UNT, EUR…)
      .trim();
    if (!/\d/.test(str) || /[A-Za-z]/.test(str)) return NaN;
    var norm = str.replace(/[\s'’]/g, '');                        // space-family + apostrophes: always thousands
    var lastComma = norm.lastIndexOf(',');
    var lastDot = norm.lastIndexOf('.');
    var num;
    if (lastComma !== -1 && lastDot !== -1) {
      num = lastComma > lastDot
        ? norm.replace(/\./g, '').replace(/,/g, '.')              // 1.234.567,89 (EU)
        : norm.replace(/,/g, '');                                 // 1,234,567.89 (US)
    } else if (lastComma !== -1 || lastDot !== -1) {
      var sep = lastComma !== -1 ? ',' : '.';
      var parts = norm.split(sep);
      var fmt = typeof __numberFormat !== 'undefined' ? __numberFormat : null;
      var thousandsShape = parts.length === 2 && parts[1].length === 3 && parts[0].length >= 1 && parts[0].length <= 3 && parts[0].charAt(0) !== '0';
      if (parts.length > 2) {
        num = parts.join('');                                     // several occurrences = thousands
      } else if (thousandsShape && fmt !== null) {
        // Document calibration (rule 5): a proven-US doc's "1,138" is 1138
        // shares; a proven-EU doc's "11,014" stays 11.014 fund units.
        num = (fmt === 'us') === (sep === ',') ? parts[0] + parts[1] : parts[0] + '.' + parts[1];
      } else {
        // No document evidence: single separator = decimal (3-decimal unit
        // counts are real: "751,169 UNT").
        num = parts[0] + '.' + parts[1];
      }
    } else {
      num = norm;
    }
    if (!/^\d*\.?\d*$/.test(num)) return NaN;
    var v = parseFloat(num);
    return isNaN(v) ? NaN : sign * v;
  } catch {
    return NaN;
  }
}

/** Split a pipe-separated pdfText line into trimmed column strings. */
export function splitCols(s: unknown): string[] {
  return String(s ?? '').split('|').map(function (c) { return c.trim(); });
}
