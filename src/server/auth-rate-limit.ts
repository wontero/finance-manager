import type { Response } from "express";
import { ipKeyGenerator, rateLimit, type Options } from "express-rate-limit";
import { sql } from "kysely";
import { authContext, type AuthDb } from "./auth-store.js";

export const authRateLimitIp = {
  keyGenerator: () => {
    const ip = authContext.getStore()?.ip;
    return ip ? ipKeyGenerator(ip) : "global";
  },
};

export function loginRateLimit(handler: Options["handler"]) {
  return rateLimit({
    ...authRateLimitIp,
    windowMs: 15 * 60_000,
    limit: () => (authContext.getStore()?.ip ? 20 : 60),
    standardHeaders: "draft-6",
    legacyHeaders: false,
    handler,
  });
}

export async function allowUserRequest(
  db: AuthDb,
  userId: string,
  limit: number,
  response: Response,
) {
  const {
    rows: [counter],
  } = await sql<{ hits: number }>`
    INSERT INTO user_request_limits (user_id, minute_bucket, hits)
    VALUES (${userId}, ${Math.floor(Date.now() / 60_000)}, 1)
    ON DUPLICATE KEY UPDATE
      hits = IF(minute_bucket >= VALUES(minute_bucket), LEAST(hits + 1, ${limit + 1}), 1),
      minute_bucket = GREATEST(minute_bucket, VALUES(minute_bucket))
    RETURNING hits
  `.execute(db);
  if (counter.hits <= limit) {
    await sql`UPDATE users SET last_seen_at = UTC_TIMESTAMP(3)
      WHERE id = CAST(${userId} AS UNSIGNED)`.execute(db);
    return true;
  }
  response
    .set({ "Cache-Control": "no-store", "Retry-After": "60" })
    .status(429)
    .json({
      error: "Demasiadas solicitudes. Vuelve a intentarlo en un minuto.",
    });
  return false;
}
