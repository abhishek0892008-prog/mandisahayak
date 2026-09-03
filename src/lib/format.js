/**
 * Presentation helpers.
 *
 * Two rules govern this file:
 *
 *  1. Times cross the wire in UTC and every window carries its own
 *     `centreTimezone`, so wall-clock rendering uses that zone rather than the
 *     browser's. A farmer in a different zone must still read the centre's
 *     clock (bookings.md §4).
 *  2. Nothing here computes a business value. Money, quantities, positions and
 *     ETAs arrive already decided by the server (architecture §18.7); these
 *     functions only format what they are given, and return null when given
 *     nothing rather than inventing a placeholder.
 */

const DEFAULT_ZONE = "Asia/Kolkata";

const LOCALE_TAG = { en: "en-IN", hi: "hi-IN" };

function tag(locale) {
  return LOCALE_TAG[locale] ?? "en-IN";
}

/** "8:00 am" in the centre's own zone. */
export function formatTime(iso, timeZone = DEFAULT_ZONE, locale = "en") {
  if (!iso) return null;

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  return new Intl.DateTimeFormat(tag(locale), {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone,
  }).format(date);
}

/** "7 Sep 2026" in the centre's own zone. */
export function formatDate(value, timeZone = DEFAULT_ZONE, locale = "en") {
  if (!value) return null;

  // A bare service date ("2026-09-07") is a calendar day, not an instant.
  // Anchoring it at midday UTC keeps it on the same day in every zone.
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value;

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  return new Intl.DateTimeFormat(tag(locale), {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone,
  }).format(date);
}

/** "7 Sep 2026, 8:00 am". */
export function formatDateTime(iso, timeZone = DEFAULT_ZONE, locale = "en") {
  const date = formatDate(iso, timeZone, locale);
  const time = formatTime(iso, timeZone, locale);

  if (!date) return null;
  return time ? `${date}, ${time}` : date;
}

/** "8:00 am – 10:00 am", the window the farmer is told to arrive in. */
export function formatTimeRange(startIso, endIso, timeZone = DEFAULT_ZONE, locale = "en") {
  const start = formatTime(startIso, timeZone, locale);
  const end = formatTime(endIso, timeZone, locale);

  if (!start) return null;
  return end ? `${start} – ${end}` : start;
}

/**
 * Money arrives as integer paise, and the server also sends `amountRupees` as
 * an exact decimal string. Prefer that string: re-deriving rupees from paise in
 * floating point is exactly the class of error the backend avoids by computing
 * in PostgreSQL `numeric`.
 */
export function formatRupees(amountRupees, locale = "en") {
  if (amountRupees === null || amountRupees === undefined) return null;

  const value = Number(amountRupees);
  if (!Number.isFinite(value)) return null;

  return new Intl.NumberFormat(tag(locale), {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/** Rate snapshots are quoted per quintal, in paise. */
export function formatPaisePerQuintal(paise, locale = "en") {
  if (paise === null || paise === undefined) return null;
  return formatRupees(Number(paise) / 100, locale);
}

// -- quantity --------------------------------------------------------------
//
// The wire field is always `quantityKg`, an integer. Farmers speak in quintal,
// so the UI collects quintal and converts before sending (farmer.md §9). The
// conversion factor comes from the server's booking constraints, never a
// literal.

export function quintalToKg(quintal, kgPerQuintal = 100) {
  const value = Number(quintal);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * kgPerQuintal);
}

export function kgToQuintal(kg, kgPerQuintal = 100) {
  const value = Number(kg);
  if (!Number.isFinite(value)) return null;
  return value / kgPerQuintal;
}

/** Drops a trailing ".0" so 25 reads as "25" and 24.805 stays exact. */
export function formatQuantity(value, locale = "en") {
  if (value === null || value === undefined) return null;

  const number = Number(value);
  if (!Number.isFinite(number)) return null;

  return new Intl.NumberFormat(tag(locale), {
    maximumFractionDigits: 3,
  }).format(number);
}

/** "1 h 15 m" — an ETA is a duration, not a clock time. */
export function formatMinutes(minutes, locale = "en", labels = { hour: "h", minute: "m" }) {
  if (minutes === null || minutes === undefined) return null;

  const total = Math.max(0, Math.round(Number(minutes)));
  if (!Number.isFinite(total)) return null;

  const hours = Math.floor(total / 60);
  const rest = total % 60;

  const format = (n) => new Intl.NumberFormat(tag(locale)).format(n);

  if (hours === 0) return `${format(rest)} ${labels.minute}`;
  if (rest === 0) return `${format(hours)} ${labels.hour}`;

  return `${format(hours)} ${labels.hour} ${format(rest)} ${labels.minute}`;
}

/** Today's date in a given zone, as the `YYYY-MM-DD` the API expects. */
export function todayInZone(timeZone = DEFAULT_ZONE) {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).format(new Date());
}

/** `YYYY-MM-DD`, `offsetDays` from today in the given zone. */
export function dateInZone(offsetDays, timeZone = DEFAULT_ZONE) {
  const base = new Date();
  base.setUTCDate(base.getUTCDate() + offsetDays);

  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).format(base);
}
