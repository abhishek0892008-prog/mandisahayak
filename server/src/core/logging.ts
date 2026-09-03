/**
 * Structured logging with mandatory redaction.
 *
 * Nothing secret may reach a log line or an audit row. This module is the single
 * chokepoint: `redact()` is applied by the logger AND by the audit writer, so a
 * caller cannot accidentally bypass it by writing to the wrong sink.
 */

const SECRET_KEY_PATTERN =
  /(otp|password|passwd|secret|pepper|token|authorization|cookie|csrf|session|hash|aadhaar|ifsc|account_number)/i;

const PHONE_PATTERN = /(\+?\d[\d\s-]{7,}\d)/g;

/** Masks a phone number to its last two digits: +919876543210 -> +91 xxxxx xx10 */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `***${digits.slice(-2)}`;
}

/**
 * Recursively redacts secret-looking keys and masks anything phone-shaped in
 * free text. Depth-limited so a cyclic or pathological object cannot hang the
 * logger.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return value.replace(PHONE_PATTERN, (m) => maskPhone(m) ?? '***');
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return '[buffer]';

  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(k)) {
        out[k] = '[redacted]';
        continue;
      }
      if (k === 'phone' || k === 'phoneE164' || k === 'phone_e164') {
        out[k] = maskPhone(String(v));
        continue;
      }
      out[k] = redact(v, depth + 1);
    }
    return out;
  }

  return '[unserialisable]';
}

type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, msg: string, meta?: Record<string, unknown>) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...(meta ? (redact(meta) as Record<string, unknown>) : {}),
  });
  // eslint-disable-next-line no-console
  if (level === 'error') console.error(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, meta),
};
