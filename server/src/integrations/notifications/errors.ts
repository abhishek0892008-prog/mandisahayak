/**
 * Delivery failure classification.
 *
 * The distinction that matters to an outbox is not "did it fail" but "is it
 * worth trying again". A provider rejecting a malformed number will reject it
 * every time; a provider that timed out probably will not. Retrying the first
 * costs money and delays the queue; giving up on the second loses a message.
 */

/** The failure will recur. Do not retry — move straight to terminal FAILED. */
export class TerminalDeliveryError extends Error {
  readonly terminal = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'TerminalDeliveryError';
  }
}

/** The failure may not recur. Retry with backoff until max_attempts. */
export class RetryableDeliveryError extends Error {
  readonly terminal = false as const;
  constructor(message: string) {
    super(message);
    this.name = 'RetryableDeliveryError';
  }
}

/**
 * An unclassified error is treated as RETRYABLE.
 *
 * Deliberate: an unknown fault is more often transient than permanent, and the
 * attempt ceiling bounds the cost of being wrong. Giving up immediately on an
 * error we failed to classify would lose messages for no gain.
 */
export function isTerminal(err: unknown): boolean {
  return err instanceof TerminalDeliveryError;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown delivery error';
}
