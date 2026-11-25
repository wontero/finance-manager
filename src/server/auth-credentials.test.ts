import { createCipheriv, randomBytes, scrypt, scryptSync } from "node:crypto";
import { HOTP, Secret } from "otpauth";
import { expect, test, vi } from "vitest";
import { authenticator, checkCredentials } from "./auth-credentials.js";

vi.mock("node:crypto", async (original) => {
  const crypto = await original<typeof import("node:crypto")>();
  return { ...crypto, scrypt: vi.fn(crypto.scrypt) };
});

test("M-005B S19: incorrect password and incorrect TOTP perform the same cryptographic work", async () => {
  const key = randomBytes(32);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const secret = new Secret({ size: 20 });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(secret.buffer)),
    cipher.final(),
  ]);
  const password = randomBytes(32).toString("base64url");
  const costs = { N: 2 ** 17, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };
  const user = {
    password_hash: scryptSync(password, salt, 64, costs),
    password_salt: salt,
    scrypt_n: costs.N,
    scrypt_r: costs.r,
    scrypt_p: costs.p,
    totp_encrypted: Buffer.concat([iv, cipher.getAuthTag(), encrypted]),
    last_totp_step: null,
  };
  const timestamp = Date.now();
  const otp = authenticator(secret);
  const valid = [0, -1, 1].map((offset) =>
    otp.generate({ timestamp: timestamp + offset * 30_000 }),
  );
  const invalid = Array.from({ length: 4 }, (_, i) =>
    String(i).padStart(6, "0"),
  ).find((token) => !valid.includes(token))!;
  const clock = vi.spyOn(Date, "now").mockReturnValue(timestamp);
  const hmac = vi.spyOn(HOTP, "generate");
  const work = async (attempt: string, token: string) => {
    vi.mocked(scrypt).mockClear();
    hmac.mockClear();
    expect((await checkCredentials(user, key, attempt, token)).outcome).toBe(
      "invalid",
    );
    expect(vi.mocked(scrypt).mock.calls.length).toBe(1);
    expect(vi.mocked(scrypt).mock.calls[0][3]).toEqual(costs);
    return hmac.mock.calls.length;
  };
  try {
    expect(await work(randomBytes(32).toString("base64url"), valid[0])).toBe(3);
    expect(await work(password, invalid)).toBe(3);
    expect(await work(password, "")).toBe(3);
  } finally {
    hmac.mockRestore();
    clock.mockRestore();
  }
});
