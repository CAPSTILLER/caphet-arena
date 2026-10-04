import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;

export function normalizeWallet(w: unknown): string | null {
  if (typeof w !== 'string' || !WALLET_RE.test(w)) return null;
  return w.toLowerCase();
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function newApiKey(): string {
  return `sk_${randomBytes(24).toString('base64url')}`;
}

/** Seed is sealed (AES-256-GCM) before it is stored so a leaked blob does not reveal a live round's hidden noise. */
export function sealSecret(secret: string, plain: string): string {
  const key = createHash('sha256').update(secret).digest();
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}

export function openSecret(secret: string, sealed: string): string {
  const [iv, tag, enc] = sealed.split('.').map((p) => Buffer.from(p, 'base64url'));
  const key = createHash('sha256').update(secret).digest();
  const d = createDecipheriv('aes-256-gcm', key, iv!);
  d.setAuthTag(tag!);
  return Buffer.concat([d.update(enc!), d.final()]).toString('utf8');
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
