/**
 * Notification delivery — provider abstraction (architecture §16.5).
 *
 * THERE IS NO REAL SMS PROVIDER IN THIS SYSTEM.
 *
 * No approved provider, no credentials, no sender ID, no TRAI DLT template
 * registration exists. Nothing here contacts a network, and nothing here may be
 * read as evidence that a message reached a phone. The only implementation is a
 * DEMO adapter that says so in its provider id, its logs and its name.
 *
 * Business code writes an outbox row and knows nothing about transports
 * (§16.5). When a real provider is approved it implements this interface and
 * drops in with no contract change.
 */
import { log } from '../../core/logging.ts';

export type DeliveryInput = {
  notificationId: string;
  channel: 'SMS' | 'IN_APP';
  toPhoneE164: string | null;
  body: string;
};

export type DeliveryResult = {
  providerMessageId: string;
  /** False for every provider that did not actually transmit to a carrier. */
  realDelivery: boolean;
};

export interface NotificationProvider {
  readonly name: string;
  /** True only for a provider that genuinely hands off to a carrier. */
  readonly isRealDelivery: boolean;
  send(input: DeliveryInput): Promise<DeliveryResult>;
}

/**
 * The only provider that exists.
 *
 * It performs NO network call. It records the attempt and returns an id
 * prefixed `DEMO-`, so a delivery record can never be mistaken for a real one
 * by a reader, a report, or a demo audience.
 */
export class DevNotificationProvider implements NotificationProvider {
  readonly name = 'DEV_DEMO';
  readonly isRealDelivery = false;

  private sends = 0;

  async send(input: DeliveryInput): Promise<DeliveryResult> {
    this.sends += 1;

    // Logged at warn, not info: an operator reading logs must not be able to
    // skim past the fact that nothing was actually sent.
    log.warn(
      `DEMO delivery (no real SMS sent) channel=${input.channel} notification=${input.notificationId}`,
    );

    return {
      providerMessageId: `DEMO-${input.notificationId}`,
      realDelivery: false,
    };
  }

  /** Test hook: how many delivery attempts this instance has handled. */
  attempts(): number {
    return this.sends;
  }

  reset(): void {
    this.sends = 0;
  }
}

let active: NotificationProvider | null = null;

/**
 * Selects the provider from configuration.
 *
 * `NOTIFICATION_PROVIDER` is read from the environment; the ONLY implemented
 * value is `dev`. Any other value is REFUSED at first use rather than silently
 * falling back to the demo adapter — a deployment that believes it configured a
 * real provider must not quietly send nothing (global rule 17).
 *
 * No credential, API key or sender ID is read here, because none exists. When a
 * real provider is approved it is registered in this switch and configured
 * entirely through environment variables.
 */
function selectProvider(): NotificationProvider {
  const name = (process.env.NOTIFICATION_PROVIDER ?? 'dev').trim().toLowerCase();
  if (name === 'dev' || name === 'demo') return new DevNotificationProvider();
  throw new Error(
    `NOTIFICATION_PROVIDER="${name}" is not implemented. The only available provider is "dev" ` +
      '(DEMO delivery). No real SMS provider is configured in this build.',
  );
}

export function getNotificationProvider(): NotificationProvider {
  if (!active) active = selectProvider();
  return active;
}

/** Test seam only. There is no configuration path that selects a real provider. */
export function setNotificationProvider(p: NotificationProvider): void {
  active = p;
}

/** Forget the cached selection so configuration is re-read. Tests only. */
export function resetNotificationProvider(): void {
  active = null;
}
