import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const CIPHER = 'aes-256-gcm';

export function parseGmailEncryptionKey(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return value.byteLength === 32 ? Buffer.from(value) : null;
  }
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) return null;
  return Buffer.from(value, 'hex');
}

export function encryptGmailTokenBundle(bundle, key, additionalData, randomBytesImpl = randomBytes) {
  const iv = randomBytesImpl(12);
  const cipher = createCipheriv(CIPHER, key, iv);
  cipher.setAAD(Buffer.from(additionalData, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(bundle), 'utf8'),
    cipher.final(),
  ]);
  return {
    version: 1,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  };
}

export function decryptGmailTokenBundle(envelope, key, additionalData) {
  if (!envelope || envelope.version !== 1 || typeof envelope.iv !== 'string'
    || typeof envelope.tag !== 'string' || typeof envelope.ciphertext !== 'string') {
    throw new TypeError('Invalid Gmail token envelope.');
  }
  const decipher = createDecipheriv(CIPHER, key, Buffer.from(envelope.iv, 'base64url'));
  decipher.setAAD(Buffer.from(additionalData, 'utf8'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
    decipher.final(),
  ]);
  const bundle = JSON.parse(plaintext.toString('utf8'));
  if (!bundle || typeof bundle.accessToken !== 'string' || typeof bundle.refreshToken !== 'string'
    || !Number.isFinite(bundle.expiresAt) || !Array.isArray(bundle.scopes)) {
    throw new TypeError('Invalid Gmail token bundle.');
  }
  return bundle;
}
