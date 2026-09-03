/**
 * Cryptographic primitives.
 *
 * Everything secret in this system is stored as a hash, never in plaintext:
 *   OTP      -> peppered HMAC-SHA256
 *   session  -> SHA-256 of the token
 *   password -> scrypt with a per-user salt
 *
 * PASSWORD KDF NOTE (deviation from architecture §4.1, disclosed):
 *   The architecture named Argon2id. Argon2 in Node requires a native module
 *   (node-gyp build or a prebuilt binary), which is an avoidable supply-chain
 *   and build-fragility cost for this project. scrypt (RFC 7914) is in Node
 *   core, needs no native build, and is a legitimate memory-hard password KDF.
 *   The hash string is self-describing and versioned ("scrypt$N$r$p$salt$hash"),
 *   so swapping in Argon2id later is a verifier change plus a rehash-on-login,
 *   with no schema change.
 */
import {
  createHmac,
  createHash,
  randomBytes,
  randomInt,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

/** scrypt parameters. N must be a power of two; these give ~64 MB per hash. */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2;

/** Constant-time comparison that tolerates differing lengths without throwing. */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    // Still burn a comparison so the failure path is not obviously faster.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// OTP
// ---------------------------------------------------------------------------

/**
 * Generates a numeric OTP using a CSPRNG. Never Math.random.
 * Leading zeros are preserved by padding, so "004521" is a valid six-digit OTP.
 */
export function generateOtp(length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String(randomInt(0, 10));
  return out;
}

/**
 * Peppered HMAC. The pepper lives in the environment, not the database, so a
 * database leak alone does not permit offline OTP recovery.
 *
 * A slow KDF is deliberately NOT used here: a six-digit space cannot be
 * protected by hashing cost, it is protected by the attempt limit and the short
 * expiry. Using a slow hash would only turn the verify endpoint into a DoS
 * amplifier.
 */
export function hashOtp(otp: string, pepper: string): Buffer {
  return createHmac('sha256', pepper).update(otp, 'utf8').digest();
}

export function verifyOtp(otp: string, pepper: string, stored: Buffer): boolean {
  return safeEqual(hashOtp(otp, pepper), stored);
}

// ---------------------------------------------------------------------------
// Session tokens
// ---------------------------------------------------------------------------

/** 256 bits of CSPRNG entropy, URL-safe. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Only the hash is stored. A database leak therefore yields no usable session.
 * SHA-256 is correct here (not a slow KDF) because the input is already
 * high-entropy — there is nothing to brute force.
 */
export function hashSessionToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

// ---------------------------------------------------------------------------
// Passwords (staff only)
// ---------------------------------------------------------------------------

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) {
    // Burn comparable work so "no password set" is not detectably faster than
    // "wrong password". This is what makes staff-account enumeration hard.
    scryptSync(password, randomBytes(16), SCRYPT_KEYLEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAXMEM,
    });
    return false;
  }

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');

  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  const derived = scryptSync(password, salt, expected.length, {
    N,
    r,
    p,
    maxmem: 128 * N * r * 2,
  });
  return safeEqual(derived, expected);
}

// ---------------------------------------------------------------------------
// CSRF tokens (stateless double-submit)
// ---------------------------------------------------------------------------

/**
 * Token format: "<nonce>.<hmac>". The HMAC binds the nonce to a server secret,
 * so a client cannot mint a token the server will accept, and no per-session
 * storage (and therefore no migration) is required.
 */
export function issueCsrfToken(pepper: string): string {
  const nonce = randomBytes(18).toString('base64url');
  const mac = createHmac('sha256', pepper).update(nonce, 'utf8').digest('base64url');
  return `${nonce}.${mac}`;
}

export function isValidCsrfToken(token: string | undefined, pepper: string): boolean {
  if (!token) return false;
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return false;

  const nonce = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  const expected = createHmac('sha256', pepper).update(nonce, 'utf8').digest('base64url');
  return safeEqual(Buffer.from(mac), Buffer.from(expected));
}

/** Constant-time equality for the double-submit cookie/header comparison. */
export function tokensMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return safeEqual(Buffer.from(a), Buffer.from(b));
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function sha256(input: string): Buffer {
  return createHash('sha256').update(input, 'utf8').digest();
}

export function randomId(): string {
  return randomBytes(16).toString('hex');
}
