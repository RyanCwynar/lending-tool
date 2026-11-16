import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, generateSecret } from "./secrets.js";
import { sign, verify } from "./signing.js";
import { isPrivateAddress, validateWebhookUrl } from "./url-guard.js";

describe("signing secrets at rest", () => {
  const key = randomBytes(32);

  it("round-trips and never stores the plaintext", () => {
    const id = randomUUID();
    const secret = generateSecret();
    const enc = encryptSecret(key, id, secret);
    expect(enc.ciphertext.toString("utf8")).not.toContain(secret.slice(6));
    expect(decryptSecret(key, id, enc)).toBe(secret);
  });

  it("fails with the wrong key, tampered data, or another subscription's id", () => {
    const id = randomUUID();
    const enc = encryptSecret(key, id, generateSecret());
    expect(() => decryptSecret(randomBytes(32), id, enc)).toThrow();
    expect(() => decryptSecret(key, randomUUID(), enc)).toThrow();
    const tampered = { ...enc, ciphertext: Buffer.from(enc.ciphertext) };
    tampered.ciphertext[0]! ^= 1;
    expect(() => decryptSecret(key, id, tampered)).toThrow();
  });
});

describe("webhook signatures", () => {
  const secret = generateSecret();
  const body = JSON.stringify({ hello: "world" });

  it("verifies a fresh signature", () => {
    expect(verify(secret, sign(secret, 1_000, body), body, 1_010)).toEqual({ ok: true });
  });
  it("rejects a modified body, the wrong secret, a stale timestamp and garbage", () => {
    const header = sign(secret, 1_000, body);
    expect(verify(secret, header, body + " ", 1_000)).toEqual({ ok: false, reason: "mismatch" });
    expect(verify(generateSecret(), header, body, 1_000)).toEqual({ ok: false, reason: "mismatch" });
    expect(verify(secret, header, body, 1_000 + 301)).toEqual({ ok: false, reason: "stale" });
    expect(verify(secret, "nonsense", body, 1_000)).toEqual({ ok: false, reason: "malformed" });
    expect(verify(secret, undefined, body, 1_000)).toEqual({ ok: false, reason: "malformed" });
  });
  it("binds the timestamp: changing t breaks the signature", () => {
    const forged = sign(secret, 1_000, body).replace("t=1000", "t=2000");
    expect(verify(secret, forged, body, 2_000)).toEqual({ ok: false, reason: "mismatch" });
  });
});

describe("SSRF guard", () => {
  it("classifies addresses", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.20.0.5", "192.168.1.1", "169.254.169.254", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "100.64.0.1"]) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    for (const a of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPrivateAddress(a), a).toBe(false);
  });

  it("rejects private, plain-http and malformed URLs unless private is allowed", async () => {
    await expect(validateWebhookUrl("https://127.0.0.1/hook", false)).rejects.toThrow(/private/);
    await expect(validateWebhookUrl("https://169.254.169.254/latest", false)).rejects.toThrow(/private/);
    await expect(validateWebhookUrl("http://8.8.8.8/hook", false)).rejects.toThrow(/https/);
    await expect(validateWebhookUrl("ftp://example.com", false)).rejects.toThrow(/http/);
    await expect(validateWebhookUrl("https://user:pw@8.8.8.8/", false)).rejects.toThrow(/credentials/);
    await expect(validateWebhookUrl("not a url", false)).rejects.toThrow(/valid/);
    await expect(validateWebhookUrl("https://8.8.8.8/hook", false)).resolves.toBeInstanceOf(URL);
    await expect(validateWebhookUrl("http://mock-receivers:9000/ok", true)).resolves.toBeInstanceOf(URL);
  });
});
