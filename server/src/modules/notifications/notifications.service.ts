/**
 * Notification service.
 *
 * Two halves, deliberately separated:
 *
 *   ENQUEUE  — called from inside a business transaction. Writes a row. Makes
 *              NO network call, contacts NO provider, and does no work that
 *              could fail for a reason unrelated to the business change.
 *
 *   DISPATCH — called separately, in its own transaction, and only then does a
 *              provider get involved. This is the whole point of an outbox: the
 *              business transaction must not depend on a transport.
 *
 * If an enqueue fails for anything other than a duplicate, the exception
 * propagates and the business transaction rolls back with it (§16.1).
 */
import type { PoolClient } from 'pg';
import { withTransaction } from '../../core/db.ts';
import { writeAudit, AuditActions } from '../../core/audit.ts';
import { getNotificationProvider } from '../../integrations/notifications/provider.ts';
import {
  dedupeKeyFor,
  normaliseLocale,
  renderNotification,
  renderTemplate,
  templateVarsFor,
  titleFor,
} from '../../engines/notifications.ts';
import { log } from '../../core/logging.ts';
import type { NotificationEvent, RenderContext } from '../../engines/notifications.ts';
import * as repo from './notifications.repository.ts';
import { errorMessage, isTerminal } from '../../integrations/notifications/errors.ts';
import { mayRetry, nextAttemptAt } from '../../engines/backoff.ts';

/**
 * Channel used by Phase 10.
 *
 * IN_APP, not SMS. No SMS row is created, because creating one would assert a
 * delivery path that does not exist — there is no approved provider, no
 * credential and no DLT template id. The provider interface accepts SMS so a
 * real provider drops in later without a contract change.
 */
const CHANNEL = 'IN_APP' as const;

/** Formats the local clock time a farmer should arrive, in the centre's zone. */
function localTime(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  }).format(at);
}

/**
 * Enqueues one booking-scoped event inside the caller's transaction.
 *
 * Returns the new row id, or null when the dedupe constraint absorbed a replay.
 */
async function enqueueForBooking(
  client: PoolClient,
  bookingId: string,
  event: NotificationEvent,
  extra: Partial<RenderContext> = {},
  dedupeIds: { paymentId?: string; status?: string } = {},
): Promise<string | null> {
  const ctx = await repo.bookingNotificationContext(client, bookingId);
  if (!ctx) return null;

  const locale = normaliseLocale(ctx.locale);
  const renderContext = {
    bookingCode: ctx.bookingCode,
    cropName: ctx.cropName,
    centreName: ctx.centreName,
    serviceDate: ctx.serviceDate,
    scheduledStartLocal: localTime(ctx.scheduledStartAt, ctx.centreTimezone),
    tokenNumber: ctx.tokenNumber,
    ...extra,
  };

  // TEMPLATE FIRST, built-in copy as the fallback.
  //
  // The fallback is NOT a silent default: the built-in renderer is the same
  // reviewed copy the templates were seeded from, it is complete by
  // construction, and taking it is logged. A template with a missing variable
  // is REJECTED rather than rendered with a blank hole — sending a farmer
  // "Payment for booking  is now " would be worse than falling back.
  const tpl = await repo.activeTemplate(client, event, CHANNEL, locale);
  let body: string;
  let templateId: string | null = null;

  if (tpl) {
    const r = renderTemplate(tpl.body_template, templateVarsFor(locale, renderContext));
    if (r.ok) {
      body = r.body;
      templateId = tpl.id;
    } else {
      log.warn(
        `notification template ${event}/${CHANNEL}/${locale} missing variables: ${r.missing.join(',')} — using built-in copy`,
      );
      body = renderNotification(event, locale, renderContext).body;
    }
  } else {
    body = renderNotification(event, locale, renderContext).body;
  }
  const rendered = { body };

  return repo.enqueue(client, {
    userId: ctx.userId,
    bookingId,
    eventKey: event,
    channel: CHANNEL,
    locale,
    dedupeKey: dedupeKeyFor(event, {
      bookingId,
      serviceDate: ctx.serviceDate,
      ...dedupeIds,
    }),
    renderedBody: rendered.body,
    templateId,
    // IN_APP needs no phone; the schema only requires one for SMS.
    toPhoneE164: null,
  });
}

// ---------------------------------------------------------------------------
// The five wired events
// ---------------------------------------------------------------------------

export function notifyBookingConfirmed(client: PoolClient, bookingId: string) {
  return enqueueForBooking(client, bookingId, 'BOOKING_CONFIRMED');
}

export function notifyBookingArrived(client: PoolClient, bookingId: string) {
  return enqueueForBooking(client, bookingId, 'BOOKING_ARRIVED');
}

export function notifyProcurementCompleted(
  client: PoolClient,
  bookingId: string,
  paymentStatus: string,
) {
  return enqueueForBooking(client, bookingId, 'PROCUREMENT_COMPLETED', { paymentStatus });
}

export function notifyPaymentBlocked(
  client: PoolClient,
  bookingId: string,
  paymentId: string,
  blockedReason: string | null,
) {
  return enqueueForBooking(
    client,
    bookingId,
    'PAYMENT_BLOCKED',
    { blockedReason },
    { paymentId },
  );
}

export function notifyPaymentUpdated(
  client: PoolClient,
  bookingId: string,
  paymentId: string,
  paymentStatus: string,
  amountRupees: string | null,
) {
  return enqueueForBooking(
    client,
    bookingId,
    'PAYMENT_UPDATED',
    { paymentStatus, amountRupees },
    { paymentId, status: paymentStatus },
  );
}

// ---------------------------------------------------------------------------
// Farmer feed
// ---------------------------------------------------------------------------

function toView(r: repo.NotificationRow) {
  const locale = normaliseLocale(r.locale);
  return {
    // The notification's own id is the address of the resource, so it is
    // exposed. No other identifier is: the booking appears as its public code,
    // and user_id / booking_id / template_id never leave the server.
    id: r.id,
    type: r.event_key,
    title: titleFor(r.event_key, locale),
    message: r.rendered_body,
    bookingCode: r.booking_code,
    locale,
    read: r.read_at !== null,
    readAt: r.read_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
    delivery: {
      channel: r.channel,
      status: r.status,
      sentAt: r.sent_at?.toISOString() ?? null,
      attempts: r.attempts,
      // Stated on every row so no reader can mistake a DEMO record for a real
      // message having reached a phone.
      demo: r.provider_message_id === null ? null : r.provider_message_id.startsWith('DEMO-'),
      realSmsDelivered: false,
    },
  };
}

export async function listMine(
  userId: string,
  opts: { unreadOnly: boolean; limit: number },
) {
  const rows = await repo.listForUser(userId, opts);
  return {
    count: rows.length,
    unreadCount: await repo.unreadCountForUser(userId),
    notifications: rows.map(toView),
  };
}

export async function unreadCount(userId: string) {
  return { unreadCount: await repo.unreadCountForUser(userId) };
}

/** Idempotent: marking an already-read notification read again still succeeds. */
export async function markRead(userId: string, notificationId: string) {
  const ok = await repo.markRead(userId, notificationId);
  return ok ? { id: notificationId, read: true } : null;
}

export async function markAllRead(userId: string) {
  return { updated: await repo.markAllRead(userId) };
}

// ---------------------------------------------------------------------------
// Dispatch — the only place a provider is ever touched
// ---------------------------------------------------------------------------

/**
 * Attempts delivery for up to `limit` queued rows.
 *
 * Runs in its OWN transaction, never inside a business transaction. Called
 * explicitly; Phase 10 builds no worker, no cron and no retry daemon, and
 * `max_attempts` (a schema CHECK) makes an infinite retry loop impossible.
 */
export async function dispatchPending(limit = 50) {
  const provider = getNotificationProvider();

  return withTransaction(async (client) => {
    const claimed = await repo.claimQueued(client, limit);
    const now = new Date();
    let sent = 0;
    let retrying = 0;
    let failed = 0;
    let suppressed = 0;

    for (const row of claimed) {
      // Preference check happens at DELIVERY, not at enqueue: the record that
      // the event occurred is worth keeping even when the user does not want
      // to be told about it on this channel (architecture §16.5).
      const dctx = await repo.deliveryContext(client, row.id);
      if (dctx && !(await repo.notificationEnabled(client, dctx.user_id, dctx.channel, dctx.event_key))) {
        await repo.markSuppressed(client, row.id, 'USER_OPTED_OUT');
        suppressed += 1;
        continue;
      }

      try {
        const result = await provider.send({
          notificationId: row.id,
          channel: row.channel as 'SMS' | 'IN_APP',
          toPhoneE164: row.to_phone_e164,
          body: row.rendered_body,
        });
        await repo.markSent(client, row.id, result.providerMessageId);
        sent += 1;
      } catch (err) {
        // The attempt about to be recorded is this row's (attempts + 1)-th.
        const attemptNo = row.attempts + 1;
        const terminal = isTerminal(err);
        const willRetry = !terminal && mayRetry(attemptNo, row.max_attempts);

        await repo.recordFailure(client, row.id, errorMessage(err), {
          willRetry,
          nextAttemptAt: nextAttemptAt(now, attemptNo),
        });

        if (willRetry) retrying += 1;
        else failed += 1;
      }
    }

    if (claimed.length > 0) {
      await writeAudit(client, {
        action: AuditActions.NOTIFICATION_DISPATCHED,
        entityType: 'notification',
        actorUserId: null,
        actorRole: 'SYSTEM',
        metadata: {
          provider: provider.name,
          realDelivery: provider.isRealDelivery,
          claimed: claimed.length,
          sent,
          retrying,
          failed,
          suppressed,
        },
      });
    }

    return { claimed: claimed.length, sent, retrying, failed, suppressed, provider: provider.name };
  });
}

/**
 * Dead letters: rows that will never be delivered.
 *
 * Either the provider said the failure would recur, or the attempt ceiling is
 * exhausted. They are kept, not deleted — the fact that a farmer was NOT told
 * something is itself worth retaining.
 */
export async function listDeadLettered(limit = 50) {
  return repo.listFailed(limit);
}

// ---------------------------------------------------------------------------
// Preferences (Phase 12)
// ---------------------------------------------------------------------------

export async function getPreferences(userId: string) {
  const rows = await repo.listPreferences(userId);
  return {
    // Stated explicitly so a client never has to guess what an absent row means.
    defaultWhenUnset: 'ENABLED',
    note: 'Every notification FarmQueue sends is transactional and about your own booking, procurement or payment.',
    preferences: rows.map((r) => ({
      channel: r.channel,
      event: r.event_key,
      scope: r.event_key === null ? 'CHANNEL' : 'EVENT',
      enabled: r.enabled,
    })),
  };
}

export async function updatePreference(
  userId: string,
  channel: 'SMS' | 'IN_APP',
  event: string | null,
  enabled: boolean,
) {
  await repo.setPreference(userId, channel, event, enabled);
  return getPreferences(userId);
}
