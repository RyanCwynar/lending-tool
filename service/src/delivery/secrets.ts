import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Webhook signing secrets.
 *
 * Why encrypted and not hashed: we must *use* the secret to compute an HMAC on every delivery. Storing only a hash
 * and signing with that hash would make the hash itself the secret, so a database leak would still let an attacker
 * forge alerts. Hashing is right for secrets we *verify* (passwords, inbound API keys), not for secrets we sign with.
 *
 * AES-256-GCM with a random 12-byte IV per secret. The subscription id is bound as additional authenticated data,
 * so a ciphertext copied onto another subscription row fails to decrypt.
 */

export function generateSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

export interface EncryptedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

export function encryptSecret(key: Buffer, subscriptionId: string, secret: string): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(subscriptionId));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

/** Throws if the key is wrong, the data was tampered with, or it belongs to another subscription. */
export function decryptSecret(key: Buffer, subscriptionId: string, enc: EncryptedSecret): string {
  const decipher = createDecipheriv("aes-256-gcm", key, enc.iv);
  decipher.setAAD(Buffer.from(subscriptionId));
  decipher.setAuthTag(enc.tag);
  return Buffer.concat([decipher.update(enc.ciphertext), decipher.final()]).toString("utf8");
}
