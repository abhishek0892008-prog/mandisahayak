/**
 * DEMO_MODE only: the most recent OTP per phone, held IN MEMORY.
 *
 * Deliberately not persisted — there is no plaintext OTP column anywhere in the
 * schema and this must not become one. The store is a no-op unless DEMO_MODE is
 * enabled, and it is read only by the token-protected dev endpoint.
 *
 * This exists so a demo can be given on stage without live SMS. It is NEVER a
 * path by which an OTP reaches an authentication response body.
 */
import { getConfig } from '../../core/config.ts';

type Entry = { otp: string; issuedAt: number };

const store = new Map<string, Entry>();
const MAX_ENTRIES = 200;

export function recordDemoOtp(phone: string, otp: string): void {
  if (!getConfig().DEMO_MODE) return;
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest) store.delete(oldest);
  }
  store.set(phone, { otp, issuedAt: Date.now() });
}

export function readDemoOtp(phone: string): string | null {
  if (!getConfig().DEMO_MODE) return null;
  const entry = store.get(phone);
  if (!entry) return null;
  if (Date.now() - entry.issuedAt > getConfig().OTP_TTL_SECONDS * 1000) {
    store.delete(phone);
    return null;
  }
  return entry.otp;
}

export function clearDemoOtps(): void {
  store.clear();
}
