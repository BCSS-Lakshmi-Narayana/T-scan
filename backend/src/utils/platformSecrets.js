/**
 * Encryption for per-tenant BluGate credentials.
 *
 * BluGate issues each tenant one API key and client code, shared by every
 * platform. They are stored in that tenant's own database (models/BlugateConfig)
 * and never in an env file, so one tenant's quota can never be spent by another.
 *
 * They are encrypted at rest rather than hashed, because unlike a password they
 * have to be recovered in full to sign an outbound request. AES-256-GCM gives
 * confidentiality plus an auth tag, so a tampered ciphertext fails to decrypt
 * instead of yielding garbage that would be sent to the gateway as a key.
 *
 * Stored form:  enc:v1:<iv-b64>:<tag-b64>:<ciphertext-b64>
 */

const crypto = require('crypto');

const ENC_PREFIX = 'enc:v1:';

const isEncrypted = (value) => String(value || '').startsWith(ENC_PREFIX);

/**
 * The 32-byte key, derived from PLATFORM_SECRETS_KEY when set and JWT_SECRET
 * otherwise. Falling back to JWT_SECRET keeps a deployment working without new
 * configuration; setting PLATFORM_SECRETS_KEY separately means rotating the JWT
 * signing secret does not strand every stored credential.
 *
 * Throws rather than defaulting: a hardcoded fallback key would make the
 * encryption decorative.
 */
const getSecretsKey = () => {
  const raw = String(process.env.PLATFORM_SECRETS_KEY || process.env.JWT_SECRET || '').trim();
  if (!raw) {
    throw new Error('PLATFORM_SECRETS_KEY (or JWT_SECRET) is required to store platform credentials');
  }
  return crypto.createHash('sha256').update(raw).digest();
};

/** Encrypt a credential for storage. Returns null for empty input. */
const encryptSecret = (plain) => {
  const value = String(plain || '').trim();
  if (!value) return null;
  if (isEncrypted(value)) return value; // already stored form — re-encrypting would double-wrap

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getSecretsKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
};

/**
 * Decrypt a stored credential. Returns null when it is missing or cannot be
 * decrypted (wrong key, tampered ciphertext) — callers treat null as "not
 * configured" and fail closed rather than calling the gateway with a bad key.
 *
 * A value with no prefix is legacy plaintext and is returned as-is, so rows
 * written before this module existed keep working until they are re-saved.
 */
const decryptSecret = (stored) => {
  const value = String(stored || '').trim();
  if (!value) return null;
  if (!isEncrypted(value)) return value;

  try {
    const [ivB64, tagB64, dataB64] = value.slice(ENC_PREFIX.length).split(':');
    if (!ivB64 || !tagB64 || !dataB64) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', getSecretsKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (_) {
    return null;
  }
};

module.exports = {
  encryptSecret,
  decryptSecret,
  isEncrypted,
};
