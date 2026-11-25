import { ipKeyGenerator, rateLimit, type Options } from "express-rate-limit";
import { authContext } from "./auth-store.js";

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
