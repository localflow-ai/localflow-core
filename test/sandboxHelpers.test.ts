import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseMoney, parseNum, splitCols } from '../src/sandboxHelpers'

const here = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// parseNum — quantities, prices, percentages.
// Values use synthetic amounts but the exact *shapes* seen across pdf-samples
// (French space-thousands + decimal comma, Swiss apostrophe-thousands, units).
// ---------------------------------------------------------------------------

describe('parseNum', () => {
  it.each([
    ['1 800,00 UNT', 1800],        // space thousands + decimal comma + unit  (was the truncation bug → 1)
    ['3 295,00 UNT', 3295],
    ['500,00 UNT', 500],
    ['751,169 UNT', 751.169],      // fractional units
    ['250,946854', 250.946854],    // plain decimal
    ['1 119,20', 1119.2],          // space thousands
    ['1 284,937605', 1284.937605],
    ['5,23', 5.23],
    ['0,00 UNT', 0],
    ["6'751'498", 6751498],        // Swiss apostrophe thousands, no decimal
    ["1'234.56", 1234.56],         // Swiss apostrophe thousands + dot decimal
    ['3.65', 3.65],                // dot decimal
    ['-0.53', -0.53],              // negative
    ['12,5%', 12.5],               // trailing percent
  ])('parses %j → %d', (input, expected) => {
    expect(parseNum(input)).toBeCloseTo(expected, 6)
  })

  it.each([null, undefined, '', 'abc', {}])('returns NaN for %j', (input) => {
    expect(parseNum(input as unknown)).toBeNaN()
  })
})

// ---------------------------------------------------------------------------
// parseMoney — monetary columns. Parses amounts (incl. units / large values),
// rejects account numbers, dates, references and descriptions.
// ---------------------------------------------------------------------------

describe('parseMoney', () => {
  it.each([
    ['451 704,34', 451704.34],     // 8-digit integer run once separators removed (was rejected by old guard)
    ['8 629 202,44', 8629202.44],  // millions
    ['179 072,00', 179072],
    ['1 000,30', 1000.3],
    ['- 6 720,76', -6720.76],      // negative with space after sign
    ['1 234,56 EUR', 1234.56],     // trailing currency code
    ['1 234,56 CHF', 1234.56],
    ['1 234,56 €', 1234.56],       // currency symbol
    ['31,34 ¤', 31.34],            // euro mis-encoded as the generic currency sign ¤ (Latin-1 0xA4)
    ['3 995,92 ¤', 3995.92],
    ["6'751'498", 6751498],        // Swiss apostrophe
    ['5,23', 5.23],
    ['0,00', 0],
  ])('parses %j → %d', (input, expected) => {
    expect(parseMoney(input)).toBeCloseTo(expected, 2)
  })

  it.each([
    '30568 19925 00032977106',     // account number (spaced)
    '00032977106',                 // account number (11 digits)
    '1410-002874',                 // policy/reference number
    '31/03/2026',                  // date
    'CARTE X3403',                 // transaction description
    'VIR RECU 7141686480',         // reference
    'ACTIONS',                     // section label
    '',
  ])('rejects %j → NaN', (input) => {
    expect(parseMoney(input)).toBeNaN()
  })
})

// ---------------------------------------------------------------------------
// splitCols
// ---------------------------------------------------------------------------

describe('splitCols', () => {
  it('splits and trims', () => {
    expect(splitCols('US02079K3059 | ALPHABET CL.A | 1 800,00 UNT')).toEqual(
      ['US02079K3059', 'ALPHABET CL.A', '1 800,00 UNT'],
    )
  })
  it('keeps empty trailing columns', () => {
    expect(splitCols('A | B |')).toEqual(['A', 'B', ''])
  })
  it('handles non-strings', () => {
    expect(splitCols(null)).toEqual([''])
  })
})

// ---------------------------------------------------------------------------
// Sample-driven: every number-shaped token extracted from the real pdf-samples
// must parse to the same value an independent reference parse produces (catches
// truncation / dropped separators on shapes we didn't hand-enumerate above).
//
// The fixture is generated locally by `node test/generate-sample-tokens.mjs`
// from localflow-proxy/pdf-samples (private statements) and is git-ignored, so
// this block skips when the fixture is absent (CI / fresh checkout).
// ---------------------------------------------------------------------------

const fixturePath = join(here, 'fixtures', 'sample-number-tokens.json')

// Independent reimplementation of the numeric normalization — if the library
// regresses (e.g. stops stripping thousands spaces) it will diverge from this.
function refParse(token: string): number {
  return parseFloat(token.replace(/[\s']/g, '').replace(/,/g, '.'))
}

describe('parseNum against real pdf-sample tokens', () => {
  if (!existsSync(fixturePath)) {
    it.skip('fixture not present (run test/generate-sample-tokens.mjs)', () => {})
    return
  }
  const tokens: string[] = JSON.parse(readFileSync(fixturePath, 'utf8'))
  it(`fixture has tokens`, () => expect(tokens.length).toBeGreaterThan(0))
  it.each(tokens)('parses sample token %j correctly', (token) => {
    const got = parseNum(token)
    expect(got).not.toBeNaN()
    expect(got).toBeCloseTo(refParse(token), 6)
  })
})
