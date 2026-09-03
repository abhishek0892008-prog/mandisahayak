/**
 * Notification rendering and dedupe keys — PURE.
 *
 * No database, no clock, no I/O. Two responsibilities, both of which must have
 * exactly one definition:
 *
 *   1. The DEDUPE KEY for an event. This is what makes a replayed business
 *      event harmless: the key is deterministic, and the database's UNIQUE
 *      constraint — not an application "have we sent this?" check — discards
 *      the second insert (architecture §16.2).
 *
 *   2. The farmer-facing COPY, per locale.
 *
 * FARMER-SAFE BY CONSTRUCTION: every input below is a value the farmer is
 * already entitled to see through an existing endpoint. This module cannot
 * render an internal id, a SQL error, audit metadata, officer identity, or any
 * authentication material, because it is never given them.
 *
 * DEVIATION (docs/phase-10-notifications.md §7.2): architecture §16.3 puts copy
 * in `notification_templates`. It lives here instead, and `template_id` stays
 * NULL, because template rows are versioned product content that must be
 * DLT-registerable before any real SMS — seeding them now would imply an
 * approval nobody has given.
 */

/** The keys Phase 10 actually enqueues. The domain permits more (0014). */
export type NotificationEvent =
  | 'BOOKING_CONFIRMED'
  | 'BOOKING_ARRIVED'
  | 'PROCUREMENT_COMPLETED'
  | 'PAYMENT_BLOCKED'
  | 'PAYMENT_UPDATED'
  | 'QUEUE_APPROACHING';

export type Locale = 'en' | 'hi';

/** Only ever the two the schema's locale_t permits; anything else falls back. */
export function normaliseLocale(value: string | null | undefined): Locale {
  return value === 'hi' ? 'hi' : 'en';
}

// ---------------------------------------------------------------------------
// Dedupe keys (§16.2)
// ---------------------------------------------------------------------------

/**
 * `entity:id:EVENT[:qualifier]` — the convention architecture §16.2 already
 * established. Deterministic, so the same business event always produces the
 * same key and the UNIQUE constraint can do its job.
 *
 * PAYMENT_UPDATED is qualified by status because §16.4 scopes its dedupe to
 * "payment + status": a payment moving PENDING -> INITIATED -> PAID is three
 * distinct facts a farmer should hear about, not one repeated.
 */
export function dedupeKeyFor(
  event: NotificationEvent,
  ids: { bookingId?: string; paymentId?: string; serviceDate?: string; status?: string },
): string {
  switch (event) {
    case 'BOOKING_CONFIRMED':
    case 'BOOKING_ARRIVED':
    case 'PROCUREMENT_COMPLETED':
      return `booking:${ids.bookingId}:${event}`;
    case 'PAYMENT_BLOCKED':
      return `payment:${ids.paymentId}:PAYMENT_BLOCKED`;
    case 'PAYMENT_UPDATED':
      return `payment:${ids.paymentId}:PAYMENT_UPDATED:${ids.status}`;
    case 'QUEUE_APPROACHING':
      // Per service date: a farmer may legitimately be warned once per day, and
      // never twice for the same day. Nothing enqueues this today (§9).
      return `booking:${ids.bookingId}:QUEUE_APPROACHING:${ids.serviceDate}`;
  }
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/** Everything the renderer may know. Deliberately small. */
export type RenderContext = {
  bookingCode?: string;
  cropName?: string;
  centreName?: string;
  serviceDate?: string;
  scheduledStartLocal?: string;
  tokenNumber?: number;
  queuePosition?: number | null;
  estimatedWaitMinutes?: number | null;
  paymentStatus?: string;
  amountRupees?: string | null;
  blockedReason?: string | null;
};

export type RenderedNotification = { title: string; body: string };

const TITLES: Record<NotificationEvent, Record<Locale, string>> = {
  BOOKING_CONFIRMED: { en: 'Booking confirmed', hi: 'बुकिंग की पुष्टि हुई' },
  BOOKING_ARRIVED: { en: 'Arrival recorded', hi: 'आगमन दर्ज किया गया' },
  PROCUREMENT_COMPLETED: { en: 'Procurement recorded', hi: 'खरीद दर्ज की गई' },
  PAYMENT_BLOCKED: { en: 'Payment needs attention', hi: 'भुगतान पर ध्यान देना आवश्यक' },
  PAYMENT_UPDATED: { en: 'Payment status updated', hi: 'भुगतान की स्थिति अपडेट हुई' },
  QUEUE_APPROACHING: { en: 'Your turn is approaching', hi: 'आपकी बारी नज़दीक है' },
};

/**
 * Why a payment could not be priced, in words a farmer can act on.
 *
 * These are the SAME reason codes GET /bookings/:code/payment already returns,
 * so this discloses nothing new — it only makes them readable.
 */
const BLOCKED_REASON: Record<string, Record<Locale, string>> = {
  MSP_AMBIGUOUS: {
    en: 'the grade of your crop has not been recorded yet, so the support price cannot be determined',
    hi: 'आपकी फसल का ग्रेड अभी दर्ज नहीं हुआ है, इसलिए समर्थन मूल्य तय नहीं किया जा सका',
  },
  NO_ACTIVE_MSP: {
    en: 'no active support price is available for this crop and grade',
    hi: 'इस फसल और ग्रेड के लिए कोई सक्रिय समर्थन मूल्य उपलब्ध नहीं है',
  },
  AWAITING_QUALITY: {
    en: 'the quality assessment is still pending',
    hi: 'गुणवत्ता जाँच अभी बाकी है',
  },
  POLICY_HOLD: {
    en: 'the payment is on hold under current policy',
    hi: 'वर्तमान नीति के तहत भुगतान रोका गया है',
  },
};

export function blockedReasonText(code: string | null | undefined, locale: Locale): string {
  const entry = code ? BLOCKED_REASON[code] : undefined;
  if (entry) return entry[locale];
  return locale === 'hi'
    ? 'भुगतान की गणना अभी नहीं की जा सकी'
    : 'the payment could not be calculated yet';
}

export function renderNotification(
  event: NotificationEvent,
  locale: Locale,
  c: RenderContext,
): RenderedNotification {
  const title = TITLES[event][locale];
  const code = c.bookingCode ?? '';
  const crop = c.cropName ?? '';
  const centre = c.centreName ?? '';

  let body: string;
  switch (event) {
    case 'BOOKING_CONFIRMED':
      body =
        locale === 'hi'
          ? `आपकी ${crop} की बुकिंग ${code} ${centre} पर ${c.serviceDate} को ${c.scheduledStartLocal} बजे के लिए पक्की हो गई है। टोकन ${c.tokenNumber}।`
          : `Your ${crop} booking ${code} is confirmed at ${centre} on ${c.serviceDate} at ${c.scheduledStartLocal}. Token ${c.tokenNumber}.`;
      break;

    case 'BOOKING_ARRIVED':
      body =
        locale === 'hi'
          ? `${centre} पर आपका आगमन दर्ज कर लिया गया है। बुकिंग ${code}, टोकन ${c.tokenNumber}। कृपया अपनी बारी की प्रतीक्षा करें।`
          : `Your arrival at ${centre} has been recorded. Booking ${code}, token ${c.tokenNumber}. Please wait for your turn.`;
      break;

    case 'PROCUREMENT_COMPLETED':
      body =
        locale === 'hi'
          ? `बुकिंग ${code} के लिए आपकी उपज की खरीद दर्ज कर ली गई है। भुगतान की स्थिति: ${c.paymentStatus}।`
          : `Procurement for booking ${code} has been recorded. Payment status: ${c.paymentStatus}.`;
      break;

    case 'PAYMENT_BLOCKED':
      body =
        locale === 'hi'
          ? `बुकिंग ${code} का भुगतान अभी रुका हुआ है क्योंकि ${blockedReasonText(c.blockedReason, 'hi')}। कृपया खरीद केंद्र से संपर्क करें।`
          : `Payment for booking ${code} is on hold because ${blockedReasonText(c.blockedReason, 'en')}. Please contact the procurement centre.`;
      break;

    case 'PAYMENT_UPDATED':
      body =
        c.amountRupees != null
          ? locale === 'hi'
            ? `बुकिंग ${code} के भुगतान की स्थिति अब ${c.paymentStatus} है। राशि ₹${c.amountRupees}।`
            : `Payment for booking ${code} is now ${c.paymentStatus}. Amount ₹${c.amountRupees}.`
          : locale === 'hi'
            ? `बुकिंग ${code} के भुगतान की स्थिति अब ${c.paymentStatus} है।`
            : `Payment for booking ${code} is now ${c.paymentStatus}.`;
      break;

    case 'QUEUE_APPROACHING':
      body =
        locale === 'hi'
          ? `${centre} पर आपकी बारी नज़दीक है। बुकिंग ${code}, टोकन ${c.tokenNumber}, कतार में स्थान ${c.queuePosition}।`
          : `Your turn at ${centre} is approaching. Booking ${code}, token ${c.tokenNumber}, queue position ${c.queuePosition}.`;
      break;
  }

  return { title, body };
}

/** Title for a stored row, derived from its event key rather than a column. */
export function titleFor(event: string, locale: Locale): string {
  const t = TITLES[event as NotificationEvent];
  return t ? t[locale] : event;
}

// ---------------------------------------------------------------------------
// Template rendering (Phase 12)
// ---------------------------------------------------------------------------

export type TemplateRenderResult =
  | { ok: true; body: string }
  | { ok: false; missing: string[] };

const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;

/**
 * Substitutes `{name}` placeholders from a template row.
 *
 * A MISSING VARIABLE IS AN ERROR, not an empty string. Rendering
 * "Payment for booking  is now " and sending it to a farmer is worse than
 * failing loudly: the caller falls back to the built-in copy, which is
 * complete by construction.
 *
 * Values are substituted verbatim. There is no HTML or SQL context here — the
 * result is stored in `rendered_body` and shown as text — so no escaping is
 * applied, and none is needed.
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string | number | null | undefined>,
): TemplateRenderResult {
  const missing: string[] = [];
  const body = template.replace(PLACEHOLDER, (_m, name: string) => {
    const v = vars[name];
    if (v === undefined || v === null || v === '') {
      missing.push(name);
      return '';
    }
    return String(v);
  });
  return missing.length > 0 ? { ok: false, missing } : { ok: true, body };
}

/** The variables a template body actually references. */
export function templateVariables(template: string): string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1]))];
}

/**
 * The flat variable bag a template is rendered against.
 *
 * Derived from the same RenderContext the built-in copy uses, so the two can
 * never drift apart in what they are ALLOWED to say. `blockedReasonText` and
 * `amountSuffix` are pre-composed here because a template must not contain
 * conditional logic.
 */
export function templateVarsFor(
  locale: Locale,
  c: RenderContext,
): Record<string, string | number | null | undefined> {
  const amount =
    c.amountRupees == null
      ? ''
      : locale === 'hi'
        ? ` राशि ₹${c.amountRupees}।`
        : ` Amount ₹${c.amountRupees}.`;
  return {
    bookingCode: c.bookingCode,
    cropName: c.cropName,
    centreName: c.centreName,
    serviceDate: c.serviceDate,
    scheduledStartLocal: c.scheduledStartLocal,
    tokenNumber: c.tokenNumber,
    queuePosition: c.queuePosition,
    paymentStatus: c.paymentStatus,
    amountRupees: c.amountRupees,
    // Always non-empty so `{amountSuffix}` never counts as missing.
    amountSuffix: amount === '' ? ' ' : amount,
    blockedReasonText: blockedReasonText(c.blockedReason, locale),
  };
}
