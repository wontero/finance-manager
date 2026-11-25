import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { sql } from "kysely";
import { Secret, TOTP } from "otpauth";
import {
  authEvent,
  authTransaction,
  revokeAll,
  type AuthDb,
  type AuthUser,
} from "./auth-store.js";

const params = { N: 2 ** 17, r: 8, p: 1 };
const maxmem = 160 * 1024 * 1024;

function passwordHash(password: string, salt: Buffer, costs = params) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, { ...costs, maxmem }, (error, hash) => {
      if (error) reject(error);
      else resolve(hash);
    });
  });
}

export function authenticator(secret: Secret) {
  return new TOTP({
    issuer: "Finance Manager",
    label: "Cuenta personal",
    secret,
  });
}

function encrypt(key: Buffer, secret: Secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(secret.buffer)),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

function decrypt(key: Buffer, encrypted: Buffer) {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    encrypted.subarray(0, 12),
  );
  decipher.setAuthTag(encrypted.subarray(12, 28));
  return Secret.fromHex(
    Buffer.concat([
      decipher.update(encrypted.subarray(28)),
      decipher.final(),
    ]).toString("hex"),
  );
}

export async function replaceUser(
  db: AuthDb,
  key: Buffer,
  password: string,
  secret: Secret,
) {
  if (password.length < 12 || Buffer.byteLength(password) > 1024)
    throw new Error(
      "La contraseña debe tener al menos 12 caracteres y como máximo 1024 bytes.",
    );
  const salt = randomBytes(16);
  const hash = await passwordHash(password, salt);
  const encrypted = encrypt(key, secret);
  await authTransaction(db, async (trx) => {
    await sql`UPDATE auth_users SET password_hash = ${hash}, password_salt = ${salt},
      scrypt_n = ${params.N}, scrypt_r = ${params.r}, scrypt_p = ${params.p},
      totp_encrypted = ${encrypted}, last_totp_step = NULL, updated_at = UTC_TIMESTAMP(3)
      WHERE id = 1`.execute(trx);
    await revokeAll(trx);
    await authEvent(trx, "setup", "success");
  });
}

export async function checkCredentials(
  user: AuthUser,
  key: Buffer | undefined,
  password: string,
  token: string,
) {
  if (
    !key ||
    !user.totp_encrypted ||
    !user.password_hash ||
    !user.password_salt ||
    !user.scrypt_n ||
    !user.scrypt_r ||
    !user.scrypt_p
  )
    return { outcome: "error" } as const;
  let secret;
  try {
    secret = decrypt(key, user.totp_encrypted);
  } catch {
    console.error("No se pudo descifrar TOTP. Comprueba TOTP_ENCRYPTION_KEY.");
    return { outcome: "error" } as const;
  }
  const hash = await passwordHash(password, user.password_salt, {
    N: user.scrypt_n,
    r: user.scrypt_r,
    p: user.scrypt_p,
  });
  const passwordMatches = timingSafeEqual(hash, user.password_hash);
  const timestamp = Date.now();
  const clockStep = Math.floor(timestamp / 30_000);
  const validFormat = /^[0-9]{6}$/.test(token);
  const otp = authenticator(secret);
  const offsets = [0, -1, 1];
  // OTPAuth stops at the first match, so validate each step independently.
  const matches = offsets.map((offset) =>
    otp.validate({
      token: validFormat ? token : "000000",
      timestamp: timestamp + offset * 30_000,
      window: 0,
    }),
  );
  const match = matches.indexOf(0);
  const step = match === -1 ? -1 : clockStep + offsets[match];
  if (
    passwordMatches &&
    validFormat &&
    step >= 0 &&
    (user.last_totp_step === null || step > Number(user.last_totp_step))
  )
    return { outcome: "success", step } as const;
  return { outcome: "invalid" } as const;
}
