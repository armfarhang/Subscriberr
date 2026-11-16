import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

// Encrypted-column format (Spec §6.0 rule 6): v1:<keyId>:<base64(iv ‖ tag ‖ ciphertext)>
// AES-256-GCM, key derived from APP_SECRET with HKDF. The key id allows APP_SECRET rotation later.

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface SecretBox {
  readonly keyId: string;
  encrypt(plaintext: string): string;
  decrypt(payload: string): string;
}

function deriveKey(appSecret: string, keyId: string): Buffer {
  return Buffer.from(hkdfSync('sha256', appSecret, 'subscriberr', `column-encryption:${VERSION}:${keyId}`, 32));
}

export function createSecretBox(appSecret: string, keyId = 'k1'): SecretBox {
  if (!/^[A-Za-z0-9_-]+$/.test(keyId)) throw new Error('Invalid key id');
  const key = deriveKey(appSecret, keyId);
  return {
    keyId,
    encrypt(plaintext) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const blob = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
      return `${VERSION}:${keyId}:${blob.toString('base64')}`;
    },
    decrypt(payload) {
      const [version, id, b64, ...rest] = payload.split(':');
      if (version !== VERSION || !id || !b64 || rest.length > 0) throw new Error('Unsupported ciphertext format');
      if (id !== keyId) throw new Error(`Ciphertext was encrypted with key "${id}", not "${keyId}"`);
      const blob = Buffer.from(b64, 'base64');
      if (blob.length < IV_BYTES + TAG_BYTES) throw new Error('Ciphertext is truncated');
      // A fixed tag length means a truncated (weaker) authentication tag can never be accepted.
      const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES });
      decipher.setAuthTag(blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      return Buffer.concat([decipher.update(blob.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
    },
  };
}

/** Random URL-safe token (session ids, OAuth state). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** One-way hash used to store session ids (the cookie value itself is never stored). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
