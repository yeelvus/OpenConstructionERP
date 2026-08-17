// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
/**
 * Canonical money primitives for the Decimal-as-string backend contract.
 *
 * The backend serialises every monetary value as a JSON *string* (a
 * `decimal.Decimal` rendered verbatim, e.g. `"1234.56"`) so large totals
 * round-trip without float precision loss and stay locale-neutral. The
 * TypeScript response types frequently declare these fields as `number`,
 * which is a lie: at runtime they arrive as strings. Calling `.toFixed()`
 * on that string throws (`"…".toFixed is not a function`), and a binary
 * `+` concatenates instead of adding. That mismatch is the single most
 * common money bug in this codebase (hundreds of historical `.toFixed`
 * crash sites).
 *
 * `toNum` is the one safe coercion primitive: it accepts whatever the wire
 * actually delivers (string | number | null | undefined), and never returns
 * `NaN`/`Infinity` - those degrade to `0` so downstream arithmetic and
 * `Intl.NumberFormat` can never blow up or render "NaN".
 *
 * `formatCurrency` is the locale-aware display formatter built on top of it.
 * Unlike a naive formatter it never hard-falls-back to EUR: rendering a
 * USD/BRL/JPY amount with a Euro sign actively misinforms the operator, so
 * an unknown/blank currency yields a plain grouped number with no symbol.
 */
import { getIntlLocale } from './formatters';
import { resolveFractionDigits } from './fractionDigits';

/** Options controlling the fraction-digit policy of {@link formatCurrency}. */
export interface FormatCurrencyOptions {
  /**
   * Minimum fraction digits. Defaults to the currency's natural minor units.
   * Out-of-range and non-finite values are clamped rather than forwarded, so
   * a bad caller degrades the output instead of throwing.
   */
  minimumFractionDigits?: number;
  /**
   * Maximum fraction digits. Defaults to the currency's natural minor units.
   * When given, it is the hard constraint: the minimum bends down to meet it.
   */
  maximumFractionDigits?: number;
}

const CURRENCY_CODE_RE = /^[A-Z]{3}$/;

/** Fraction digits used when there is no usable currency code. */
const PLAIN_FRACTION_DIGITS = 2;

/**
 * Natural minor-unit count per ISO 4217 code, as the running engine sees it.
 *
 * Deliberately asks `Intl` instead of reusing `shared/ui/currencyMinorUnits`:
 * the two tables disagree on 16 codes (AFN, ALL, COP, HUF, IDR, IQD, IRR,
 * KPW, LAK, LBP, MGA, MMK, PKR, SOS, SYP, YER), where CLDR says zero decimals
 * and the static table says two. Reading the engine keeps the digits this
 * helper renders today byte-for-byte identical, which a static table would
 * silently turn into "1.234,00 Ft". `MoneyDisplay` overriding the engine is a
 * separate, deliberate choice for its own surface.
 *
 * Cached by code alone - currency digits come from CLDR `currencyData` and do
 * not vary by locale, so keying on the locale would only multiply entries.
 */
const naturalDigitsCache = new Map<string, number>();

function naturalFractionDigits(code: string): number {
  const cached = naturalDigitsCache.get(code);
  if (cached !== undefined) return cached;
  let digits = PLAIN_FRACTION_DIGITS;
  try {
    // `maximumFractionDigits` is optional in the resolved options because a
    // significant-digits formatter reports no fraction bounds at all. This one
    // never asks for significant digits, so the fallback is unreachable in
    // practice and only there to keep the value a plain number.
    const resolved = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
    }).resolvedOptions();
    digits = resolved.maximumFractionDigits ?? PLAIN_FRACTION_DIGITS;
  } catch {
    // A well-formed but unknown code never lands here (Intl treats it as a
    // two-decimal currency); this only guards a host with no currency data.
  }
  naturalDigitsCache.set(code, digits);
  return digits;
}

/**
 * Minor units of `code`, for callers that render money themselves.
 *
 * `formatCurrency` is the right answer whenever the caller can hand over the
 * whole amount, because it also places the symbol and groups the digits. Some
 * surfaces cannot: a table that right-aligns a mono column and prints the ISO
 * code in its own `<span>` would render the code twice if it switched. Those
 * still need the one thing they cannot derive - how many decimals this
 * currency actually has - and reaching for a literal `2` is what puts
 * `82000.00 CLP` in front of a Chilean estimator. The Chilean peso, the yen
 * and the won have no minor unit at all, so the cents are not merely
 * redundant, they are a quantity the currency cannot express.
 *
 * Reads the same CLDR table `formatCurrency` reads, so a value formatted
 * through either route shows the same number of decimals.
 *
 * @param currency ISO 4217 code; blank or malformed yields the plain default.
 * @returns Fraction digits to use for both the minimum and the maximum.
 */
export function currencyFractionDigits(currency?: string | null): number {
  const code = (currency || '').trim().toUpperCase();
  return CURRENCY_CODE_RE.test(code) ? naturalFractionDigits(code) : PLAIN_FRACTION_DIGITS;
}

/**
 * Coerce a backend money value to a finite `number`, NaN-guarded.
 *
 * Accepts the Decimal-as-string the wire actually carries as well as a
 * genuine `number`. `null`, `undefined`, empty string, and any value that
 * does not parse to a finite number all collapse to `0` - never `NaN` or
 * `Infinity`, so callers can safely do arithmetic and `.toFixed()` on the
 * result.
 *
 * @param v The raw value (string | number | null | undefined).
 * @returns A finite number (`0` when the input is missing or unparseable).
 */
export function toNum(v: string | number | null | undefined): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Format a monetary value for display in the current (or given) locale.
 *
 * Coerces `v` via {@link toNum} first, so a Decimal-as-string is safe input.
 *
 * - A valid ISO 4217 `currency` renders with its symbol and (by default)
 *   its own minor-unit count (2 for EUR/USD, 0 for JPY, 3 for KWD…).
 * - A blank / unknown / malformed `currency` renders a plain grouped number
 *   with no symbol - never a wrong-currency symbol.
 * - `options` overrides the fraction-digit policy (e.g. whole-number
 *   summaries pass `{ maximumFractionDigits: 0 }`). A one-sided or inverted
 *   override is reconciled with the currency's own minor units before it
 *   reaches `Intl` - see {@link resolveFractionDigits}.
 * - This never throws, for any input. Callers render money inside React
 *   components, where a `RangeError` costs the whole page rather than one
 *   cell, so a hand-rolled string backs up the `Intl` call as well.
 *
 * @param v The value (Decimal-string or number).
 * @param currency Optional ISO 4217 code.
 * @param locale Optional BCP-47 locale tag; defaults to the active UI locale.
 * @param options Optional fraction-digit overrides.
 */
export function formatCurrency(
  v: string | number | null | undefined,
  currency?: string | null,
  locale?: string,
  options?: FormatCurrencyOptions,
): string {
  const amount = toNum(v);
  const loc = locale || getIntlLocale();
  const code = (currency || '').trim().toUpperCase();
  const isValid = CURRENCY_CODE_RE.test(code);

  // Both ends are always resolved here rather than left for Intl to default,
  // so the engine's own currency table can never combine with a one-sided
  // caller override into an invalid pair. Money's default is a point rather
  // than a range: an amount in a two-decimal currency shows both decimals or
  // it does not look like money, so the floor and the ceiling are the same.
  const natural = isValid ? naturalFractionDigits(code) : PLAIN_FRACTION_DIGITS;
  const digits = resolveFractionDigits(options, { minimum: natural, maximum: natural });

  try {
    return new Intl.NumberFormat(loc, {
      ...(isValid ? { style: 'currency' as const, currency: code } : {}),
      ...digits,
    }).format(amount);
  } catch {
    // Defence in depth. The digit pair is now valid by construction, which
    // leaves a malformed `locale` tag as the only RangeError Intl can still
    // raise here, and that one arrives from outside this module. `toFixed` is
    // safe because the ceiling is already inside [0, 20] and `toNum`
    // guarantees a finite amount. The code is appended only when it is a real
    // ISO 4217 code - never echo back a malformed one as if it were a unit.
    const text = amount.toFixed(digits.maximumFractionDigits);
    return isValid ? `${text} ${code}` : text;
  }
}
