import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Field-level encryption for personal data at rest.
 *
 * AES-256-GCM, so every ciphertext is authenticated: tampering with a stored
 * IBAN produces a decryption failure rather than plausible garbage. A fresh
 * 96-bit IV is generated per encryption, which is what keeps GCM safe — reusing
 * one across two values under the same key is catastrophic, not merely untidy.
 *
 * Stored layout:  v1.<iv-base64>.<authTag-base64>.<ciphertext-base64>
 * The version prefix is what will make key rotation a migration rather than a
 * rewrite.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const VERSION = 'v1';

export class EncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionError';
  }
}

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey !== null) return cachedKey;

  const raw = process.env['ENCRYPTION_KEY'];
  if (raw === undefined || raw === '') {
    throw new EncryptionError('ENCRYPTION_KEY is not configured.');
  }

  const key = Buffer.from(raw, 'hex');
  if (key.length !== 32) {
    throw new EncryptionError(
      'ENCRYPTION_KEY must be exactly 32 bytes (64 hex characters) for AES-256.',
    );
  }

  cachedKey = key;
  return key;
}

/** Encrypts a UTF-8 string. Returns null for null input, so callers can pass through. */
export function encryptField(plaintext: string | null | undefined): string | null {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv, { authTagLength: AUTH_TAG_LENGTH });

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ].join('.');
}

/**
 * Decrypts a stored value.
 *
 * Throws on a malformed or tampered payload rather than returning a partial
 * result — a corrupted national ID must never be silently displayed as if it
 * were genuine.
 */
export function decryptField(encoded: string | null | undefined): string | null {
  if (encoded === null || encoded === undefined || encoded === '') return null;

  const parts = encoded.split('.');
  if (parts.length !== 4) {
    throw new EncryptionError('Encrypted value is malformed.');
  }

  const [version, ivPart, tagPart, cipherPart] = parts;

  if (version !== VERSION) {
    throw new EncryptionError(`Unsupported encryption version "${version ?? ''}".`);
  }

  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      getKey(),
      Buffer.from(ivPart ?? '', 'base64'),
      { authTagLength: AUTH_TAG_LENGTH },
    );
    decipher.setAuthTag(Buffer.from(tagPart ?? '', 'base64'));

    return Buffer.concat([
      decipher.update(Buffer.from(cipherPart ?? '', 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new EncryptionError('Decryption failed: the value has been altered or the key is wrong.');
  }
}

/**
 * Deterministic hash for a value that must remain searchable while encrypted.
 *
 * Keyed with the encryption key so it cannot be brute-forced from a stolen
 * database alone — an unkeyed SHA-256 of a national ID is recoverable in
 * seconds given the format.
 */
export function blindIndex(value: string): string {
  return createHash('sha256').update(getKey()).update('|').update(value.trim().toLowerCase()).digest('hex');
}

/** SHA-256, for refresh tokens — we store the hash and compare, never the token. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time comparison, so a token check cannot be timed character by character. */
export function safeCompare(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

/** A cryptographically random, URL-safe opaque token. */
export function generateOpaqueToken(bytes = 48): string {
  return randomBytes(bytes).toString('base64url');
}
