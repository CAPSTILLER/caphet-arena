import { createSiweMessage } from 'viem/siwe';
import { getAddress, verifyMessage, type Hex } from 'viem';
import { randomBytes } from 'node:crypto';
import { ApiError } from './errors.js';
import type { Store } from './store/types.js';

/**
 * Wallet login, sign-in-with-Ethereum style (EIP-4361 message, EIP-191 personal_sign).
 *
 * Flow: POST /auth/nonce {wallet}  ->  server returns the exact message to sign (nonce + expiry inside)
 *       sign it with the wallet     ->  POST /join {wallet, mode, auth:{nonce, signature}}
 * The server rebuilds the message from what it stored, so the client cannot change any field.
 * Each nonce works once and expires (default 5 minutes). Switch it on with AUTH_MODE=signature.
 */

export interface SiweConfig {
  /** Domain shown in the message. Empty means use the request host. */
  domain: string;
  /** Chain id shown in the message (8453 Base, 84532 Base Sepolia). */
  chainId: number;
  nonceTtlMs: number;
}

interface NonceDoc {
  wallet: string;
  message: string;
  expiresAt: number;
}

/** Check one signature. EOA wallets only by default; pass a verifier that talks to an RPC to support smart wallets (ERC-1271). */
export type SignatureVerifier = (address: string, message: string, signature: string) => Promise<boolean>;

export const verifyEoaSignature: SignatureVerifier = async (address, message, signature) => {
  try {
    return await verifyMessage({ address: getAddress(address), message, signature: signature as Hex });
  } catch {
    return false;
  }
};

export class WalletAuth {
  constructor(
    private store: Store,
    private cfg: SiweConfig,
    private now: () => number,
    private verify: SignatureVerifier = verifyEoaSignature,
  ) {}

  async issue(wallet: string, requestHost: string, uri: string): Promise<{ nonce: string; message: string; issuedAt: string; expiresAt: string }> {
    const nonce = randomBytes(16).toString('hex');
    const t = this.now();
    const message = createSiweMessage({
      address: getAddress(wallet),
      chainId: this.cfg.chainId,
      domain: this.cfg.domain || requestHost || 'localhost',
      nonce,
      uri,
      version: '1',
      statement: 'Sign in to the CAPHET Arena. This only proves you own this wallet. It does not move funds or approve spending.',
      issuedAt: new Date(t),
      expirationTime: new Date(t + this.cfg.nonceTtlMs),
    });
    const doc: NonceDoc = { wallet, message, expiresAt: t + this.cfg.nonceTtlMs };
    await this.store.put(`nonces/${nonce}`, doc);
    return { nonce, message, issuedAt: new Date(t).toISOString(), expiresAt: new Date(doc.expiresAt).toISOString() };
  }

  /** Throws 401 unless `signature` is a valid signature by `wallet` over a live nonce. Burns the nonce on success. */
  async check(wallet: string, proof: unknown): Promise<void> {
    const p = typeof proof === 'object' && proof !== null ? (proof as { nonce?: unknown; signature?: unknown }) : {};
    if (typeof p.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(p.nonce) || typeof p.signature !== 'string' || !/^0x[0-9a-fA-F]{130,}$/.test(p.signature) || p.signature.length > 4096) {
      throw new ApiError(401, 'signature_required', 'This server needs a wallet signature. POST /auth/nonce {wallet}, sign the returned message, then send auth:{nonce, signature} to /join.');
    }
    const doc = await this.store.get<NonceDoc>(`nonces/${p.nonce}`);
    if (!doc || doc.wallet !== wallet) throw new ApiError(401, 'bad_nonce', 'Unknown nonce for this wallet. Ask for a new one with POST /auth/nonce.');
    if (this.now() > doc.expiresAt) {
      await this.store.delete(`nonces/${p.nonce}`);
      throw new ApiError(401, 'nonce_expired', 'The sign-in message expired. Ask for a new one with POST /auth/nonce.');
    }
    if (!(await this.verify(wallet, doc.message, p.signature))) throw new ApiError(401, 'bad_signature', 'The signature does not match this wallet and message.');
    // single use: whoever deletes the marker first wins
    if (!(await this.store.putIfAbsent(`nonces-used/${p.nonce}`, { wallet, at: this.now() }))) {
      throw new ApiError(401, 'nonce_used', 'This nonce was already used. Ask for a new one with POST /auth/nonce.');
    }
    await this.store.delete(`nonces/${p.nonce}`);
  }
}
