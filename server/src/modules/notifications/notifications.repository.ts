/**
 * Notification outbox — SQL.
 *
 * The enqueue takes a `PoolClient`, never the pool. That is not a style
 * preference: it is what makes the outbox an outbox. The row is written by the
 * SAME transaction as the business change, so a notification can never exist
 * for an event that did not happen, and can never be missing for one that did
 * (architecture §16.1, P-9).
 *
 * Ownership is resolved INSIDE every query from the session's user id. There is
 * no code path that accepts a farmer id from a caller.
 */
import type { PoolClient } from 'pg';
import { query } from '../../core/db.ts';

export type NotificationRow = {
  id: string;
  event_key: string;
  channel: string;
  locale: string;
  rendered_body: string;
  status: string;
  read_at: Date | null;
  created_at: Date;
  sent_at: Date | null;
  attempts: number;
  max_attempts: number;
  provider_message_id: string | null;
  booking_code: string | null;
};

export type EnqueueInput = {
  userId: string;
  bookingId: string | null;
  eventKey: string;
  channel: 'SMS' | 'IN_APP';
  locale: string;
  dedupeKey: string;
  renderedBody: string;
  templateId?: string | null;
  toPhoneE164: string | null;
};

/**
 * Writes one outbox row, in the caller's transaction.
 *
 * `ON CONFLICT (dedupe_key) DO NOTHING` is the idempotency mechanism (§16.2):
 * a replayed business event is absorbed by the UNIQUE constraint rather than by
 * an application check, which is the only approach that survives concurrency.
 *
 * **Any other failure propagates**, and therefore rolls the business
 * transaction back. That is deliberate: a booking that could not record its own
 * confirmation is a booking the farmer would never hear about.
 *
 * Returns the id when a row was written, or null when the duplicate was
 * absorbed — so a caller can tell "enqueued" from "already enqueued" without a
 * second query.
 */
export async function enqueue(
  client: PoolClient,
  input: EnqueueInput,
): Promise<string | null> {
  const res = await client.query(
    `INSERT INTO notifications
       (user_id, booking_id, event_key, channel, locale, dedupe_key,
        rendered_body, to_phone_e164, template_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'QUEUED')
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [
      input.userId,
      input.bookingId,
      input.eventKey,
      input.channel,
      input.locale,
      input.dedupeKey,
      input.renderedBody,
      input.toPhoneE164,
      input.templateId ?? null,
    ],
  );
  return (res.rows[0] as { id: string } | undefined)?.id ?? null;
}

/** The farmer's own locale, read inside the business transaction. */
export async function localeForUser(client: PoolClient, userId: string): Promise<string> {
  const res = await client.query('SELECT locale FROM users WHERE id = $1', [userId]);
  return (res.rows[0] as { locale: string } | undefined)?.locale ?? 'en';
}

/** The user who owns a booking, plus the copy inputs, in one read. */
export async function bookingNotificationContext(
  client: PoolClient,
  bookingId: string,
): Promise<{
  userId: string;
  locale: string;
  phone: string | null;
  bookingCode: string;
  cropName: string;
  centreName: string;
  centreTimezone: string;
  serviceDate: string;
  scheduledStartAt: Date;
  tokenNumber: number;
} | null> {
  const res = await client.query(
    `SELECT u.id AS user_id, u.locale, u.phone_e164 AS phone,
            b.booking_code, cr.canonical_name AS crop_name,
            pc.name AS centre_name, pc.timezone AS centre_timezone,
            b.service_date::text AS service_date, b.scheduled_start_at, b.token_number
       FROM bookings b
       JOIN farmers f ON f.id = b.farmer_id
       JOIN users u ON u.id = f.user_id
       JOIN crops cr ON cr.id = b.crop_id
       JOIN procurement_centres pc ON pc.id = b.centre_id
      WHERE b.id = $1`,
    [bookingId],
  );
  const r = res.rows[0] as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    userId: String(r.user_id),
    locale: String(r.locale),
    phone: (r.phone as string | null) ?? null,
    bookingCode: String(r.booking_code),
    cropName: String(r.crop_name),
    centreName: String(r.centre_name),
    centreTimezone: String(r.centre_timezone),
    serviceDate: String(r.service_date),
    scheduledStartAt: r.scheduled_start_at as Date,
    tokenNumber: Number(r.token_number),
  };
}

// ---------------------------------------------------------------------------
// Farmer feed — ownership resolved in the query, every time
// ---------------------------------------------------------------------------

const FEED_SELECT = `
  SELECT n.id, n.event_key, n.channel, n.locale, n.rendered_body, n.status,
         n.read_at, n.created_at, n.sent_at, n.attempts, n.max_attempts,
         n.provider_message_id, b.booking_code
    FROM notifications n
    LEFT JOIN bookings b ON b.id = n.booking_id`;

export async function listForUser(
  userId: string,
  opts: { unreadOnly: boolean; limit: number },
): Promise<NotificationRow[]> {
  const res = await query(
    `${FEED_SELECT}
      WHERE n.user_id = $1
        AND (NOT $2::boolean OR n.read_at IS NULL)
      ORDER BY n.created_at DESC
      LIMIT $3::int`,
    [userId, opts.unreadOnly, opts.limit],
  );
  return res.rows as NotificationRow[];
}

export async function unreadCountForUser(userId: string): Promise<number> {
  const res = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM notifications
      WHERE user_id = $1 AND read_at IS NULL`,
    [userId],
  );
  return Number(res.rows[0].n);
}

/**
 * Marks ONE notification read, but only if it belongs to this user.
 *
 * Ownership is part of the UPDATE predicate, so another farmer's id matches no
 * row: the caller cannot distinguish "not yours" from "does not exist", and —
 * more importantly — no row is modified either way.
 *
 * `read_at` is the only column touched. Delivery state (`status`, `attempts`,
 * `sent_at`, `provider_message_id`) is deliberately untouched: reading a
 * notification is not delivering one.
 */
export async function markRead(userId: string, notificationId: string): Promise<boolean> {
  const res = await query(
    `UPDATE notifications
        SET read_at = now()
      WHERE id = $1 AND user_id = $2 AND read_at IS NULL
      RETURNING id`,
    [notificationId, userId],
  );
  if (res.rowCount && res.rowCount > 0) return true;

  // Distinguish "already read" (still success, idempotent) from "not yours".
  const owned = await query(
    'SELECT 1 FROM notifications WHERE id = $1 AND user_id = $2',
    [notificationId, userId],
  );
  return (owned.rowCount ?? 0) > 0;
}

export async function markAllRead(userId: string): Promise<number> {
  const res = await query(
    `UPDATE notifications SET read_at = now()
      WHERE user_id = $1 AND read_at IS NULL`,
    [userId],
  );
  return res.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Claims queued rows for delivery.
 *
 * `FOR UPDATE SKIP LOCKED` (§16.1) so two dispatchers never take the same row.
 * Not run by a daemon — Phase 10 deliberately builds no worker; this is called
 * explicitly.
 */
export type ClaimedRow = {
  id: string;
  channel: string;
  to_phone_e164: string | null;
  rendered_body: string;
  attempts: number;
  max_attempts: number;
};

/**
 * Claims due rows and marks them SENDING, in one statement.
 *
 * `FOR UPDATE SKIP LOCKED` (§16.1) so concurrent workers never take the same
 * row. `scheduled_for <= now()` is what makes backoff real: a row that failed
 * is pushed into the future and is simply not due yet.
 *
 * The status moves to SENDING inside the claim, so a row being worked on is
 * visible as such and a crashed worker leaves evidence rather than a row that
 * looks untouched.
 */
export async function claimQueued(
  client: PoolClient,
  limit: number,
): Promise<ClaimedRow[]> {
  const res = await client.query(
    `WITH due AS (
        SELECT id
          FROM notifications
         WHERE status = 'QUEUED'
           AND attempts < max_attempts
           AND scheduled_for <= now()
         ORDER BY scheduled_for
         LIMIT $1::int
         FOR UPDATE SKIP LOCKED
     )
     UPDATE notifications n
        SET status = 'SENDING'
       FROM due
      WHERE n.id = due.id
      RETURNING n.id, n.channel, n.to_phone_e164, n.rendered_body,
                n.attempts, n.max_attempts`,
    [limit],
  );
  return res.rows as ClaimedRow[];
}

/**
 * Records a failed attempt and decides what happens next.
 *
 * RETRY   -> back to QUEUED with scheduled_for pushed out by the backoff.
 *            (The schema has no RETRYING state; a QUEUED row with a future
 *            scheduled_for IS the retrying state, and the API reports it as
 *            such.)
 * TERMINAL-> FAILED. Reached either because the provider said the failure will
 *            recur, or because the attempt ceiling is now exhausted.
 *
 * `last_error` stores the message only — never a stack, query or credential.
 */
export async function recordFailure(
  client: PoolClient,
  id: string,
  error: string,
  retry: { willRetry: boolean; nextAttemptAt: Date },
): Promise<void> {
  if (retry.willRetry) {
    await client.query(
      `UPDATE notifications
          SET status = 'QUEUED', attempts = attempts + 1,
              scheduled_for = $3, last_error = left($2, 500)
        WHERE id = $1`,
      [id, error, retry.nextAttemptAt],
    );
    return;
  }
  await client.query(
    `UPDATE notifications
        SET status = 'FAILED', attempts = attempts + 1, last_error = left($2, 500)
      WHERE id = $1`,
    [id, error],
  );
}

/** Rows that exhausted their attempts or failed terminally — the dead letters. */
export async function listFailed(limit = 50): Promise<
  Array<{ id: string; event_key: string; attempts: number; last_error: string | null }>
> {
  const res = await query(
    `SELECT id, event_key, attempts, last_error
       FROM notifications WHERE status = 'FAILED'
      ORDER BY updated_at DESC LIMIT $1::int`,
    [limit],
  );
  return res.rows as Array<{
    id: string; event_key: string; attempts: number; last_error: string | null;
  }>;
}

export async function markSent(
  client: PoolClient,
  id: string,
  providerMessageId: string,
): Promise<void> {
  await client.query(
    `UPDATE notifications
        SET status = 'SENT', sent_at = now(), attempts = attempts + 1,
            provider_message_id = $2, last_error = NULL
      WHERE id = $1`,
    [id, providerMessageId],
  );
}



// ---------------------------------------------------------------------------
// Templates and preferences (Phase 12)
// ---------------------------------------------------------------------------

/** The ACTIVE template for one event/channel/locale, or null if none is seeded. */
export async function activeTemplate(
  client: PoolClient,
  eventKey: string,
  channel: string,
  locale: string,
): Promise<{ id: string; body_template: string } | null> {
  const res = await client.query(
    `SELECT id, body_template FROM notification_templates
      WHERE event_key = $1 AND channel = $2 AND locale = $3 AND status = 'ACTIVE'
      LIMIT 1`,
    [eventKey, channel, locale],
  );
  return (res.rows[0] as { id: string; body_template: string }) ?? null;
}

/**
 * Whether this user wants this event on this channel.
 *
 * Resolution order, most specific first:
 *   1. a row naming the event
 *   2. a channel-wide row
 *   3. NO ROW -> enabled
 *
 * The default is documented in migration 0015: every event is transactional and
 * about the user's own procurement, so withholding one from a user who never
 * expressed a preference would be worse than sending it.
 */
export async function notificationEnabled(
  client: PoolClient,
  userId: string,
  channel: string,
  eventKey: string,
): Promise<boolean> {
  const res = await client.query(
    `SELECT enabled FROM notification_preferences
      WHERE user_id = $1 AND channel = $2
        AND (event_key = $3 OR event_key IS NULL)
      ORDER BY (event_key IS NULL)   -- false (specific) sorts before true
      LIMIT 1`,
    [userId, channel, eventKey],
  );
  const row = res.rows[0] as { enabled: boolean } | undefined;
  return row ? row.enabled : true;
}

export async function listPreferences(userId: string) {
  const res = await query(
    `SELECT channel, event_key, enabled FROM notification_preferences
      WHERE user_id = $1 ORDER BY channel, event_key NULLS FIRST`,
    [userId],
  );
  return res.rows as Array<{ channel: string; event_key: string | null; enabled: boolean }>;
}

export async function setPreference(
  userId: string,
  channel: string,
  eventKey: string | null,
  enabled: boolean,
): Promise<void> {
  await query(
    `INSERT INTO notification_preferences (user_id, channel, event_key, enabled)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, channel, COALESCE(event_key, ''))
     DO UPDATE SET enabled = EXCLUDED.enabled`,
    [userId, channel, eventKey, enabled],
  );
}

/** Marks a row suppressed. Delivery did not happen and is not going to. */
export async function markSuppressed(
  client: PoolClient,
  id: string,
  reason: string,
): Promise<void> {
  await client.query(
    `UPDATE notifications SET status = 'SUPPRESSED', suppressed_reason = $2 WHERE id = $1`,
    [id, reason],
  );
}

/** The owning user and event of a claimed row, for preference resolution. */
export async function deliveryContext(
  client: PoolClient,
  id: string,
): Promise<{ user_id: string; event_key: string; channel: string } | null> {
  const res = await client.query(
    'SELECT user_id, event_key, channel FROM notifications WHERE id = $1',
    [id],
  );
  return (res.rows[0] as { user_id: string; event_key: string; channel: string }) ?? null;
}
