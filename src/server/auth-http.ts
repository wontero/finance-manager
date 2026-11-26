import { BlockList, isIPv6, type Socket } from "node:net";
import express, { type ErrorRequestHandler, type Express } from "express";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  createOAuthMetadata,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import {
  FinanceOAuthProvider,
  scope,
  type AuthConfig,
} from "./auth-provider.js";
import {
  authorizationForms,
  authorizationHeaders,
  googleForms,
} from "./auth-pages.js";
import { authRateLimitIp } from "./auth-rate-limit.js";
import { authContext, clientIp, type AuthDb } from "./auth-store.js";

let passengerDiagnosed = false;
let passengerWarned = false;
let passengerUntrustedWarned = false;

const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8);
loopback.addAddress("::1", "ipv6");

function isLocalPassengerSocket({
  remoteAddress,
  remoteFamily,
  localAddress,
}: Socket) {
  if (remoteAddress === undefined)
    return remoteFamily === undefined && localAddress === undefined;
  return loopback.check(remoteAddress, isIPv6(remoteAddress) ? "ipv6" : "ipv4");
}

const secretRateLimit = {
  ...authRateLimitIp,
  // Requests with 256-bit secrets must remain available without a reliable IP.
  skip: () => !authContext.getStore()?.ip,
};

export function installAuth(app: Express, config: AuthConfig, db?: AuthDb) {
  const passenger = config.trustProxy === "passenger";
  app.set("trust proxy", config.trustProxy === "loopback" ? "loopback" : false);
  const provider = new FinanceOAuthProvider(config, db);
  const options = {
    provider,
    issuerUrl: config.issuer,
    resourceServerUrl: config.resource,
    scopesSupported: [scope],
  };
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(
    config.resource,
  );
  const resourceMetadataPath = new URL(resourceMetadataUrl).pathname;

  app.use((request, _response, next) => {
    const passengerAddress = passenger
      ? request.get("!~Passenger-Client-Address")
      : undefined;
    const untrustedHeader =
      passengerAddress !== undefined && !isLocalPassengerSocket(request.socket);
    const ip = untrustedHeader
      ? null
      : clientIp(passenger ? passengerAddress : request.ip);
    if (passenger && !passengerDiagnosed) {
      passengerDiagnosed = true;
      console.info("Diagnóstico de IP de Passenger", {
        socket: request.socket.remoteFamily ?? "local",
        remoteAddress: request.socket.remoteAddress ?? null,
        passengerHeader: passengerAddress !== undefined,
        forwardedForHeader: request.get("X-Forwarded-For") !== undefined,
        ip,
      });
    }
    if (untrustedHeader) {
      if (!passengerUntrustedWarned) {
        passengerUntrustedWarned = true;
        console.warn(
          "Cabecera de Passenger ignorada por una conexión TCP que no es loopback.",
        );
      }
    } else if (passenger && !ip && !passengerWarned) {
      passengerWarned = true;
      console.warn(
        "Passenger no entregó una IP válida. El login usa los límites globales.",
      );
    }
    const agent = request.get("User-Agent");
    authContext.run(
      {
        ip,
        agent: agent
          ? Array.from(agent.replace(/[\x00-\x1f\x7f]/g, ""))
              .slice(0, 200)
              .join("")
          : null,
      },
      next,
    );
  });
  app.use(
    "/auth/google",
    (_request, response, next) => {
      authorizationHeaders(response, config);
      next();
    },
    googleForms(config, db),
  );
  app.use(
    "/authorize",
    (_request, response, next) => {
      authorizationHeaders(response, config);
      next();
    },
    authorizationForms(config, db),
  );

  app.post(
    ["/token", "/revoke"],
    express.urlencoded({ extended: false, limit: "16kb" }),
    (request, response, next) => {
      const verifier: unknown = request.body?.code_verifier;
      if (
        request.get("Authorization") ||
        request.body?.client_secret !== undefined ||
        (verifier !== undefined &&
          (typeof verifier !== "string" ||
            !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)))
      ) {
        response
          .set("Cache-Control", "no-store")
          .status(400)
          .json({ error: "invalid_request" });
        return;
      }
      next();
    },
  );

  // SDK v1 emits confidential client auth methods by default.
  const metadata = mcpAuthMetadataRouter({
    ...options,
    oauthMetadata: {
      ...createOAuthMetadata(options),
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
    },
  });
  app.get(
    "/.well-known/oauth-protected-resource",
    (request, response, next) => {
      request.url = resourceMetadataPath;
      metadata(request, response, next);
    },
  );
  app.use(metadata);
  app.use(
    mcpAuthRouter({
      ...options,
      authorizationOptions: { rateLimit: authRateLimitIp },
      tokenOptions: { rateLimit: secretRateLimit },
      revocationOptions: { rateLimit: secretRateLimit },
      clientRegistrationOptions: {
        clientIdGeneration: false,
        rateLimit: authRateLimitIp,
      },
    }),
  );

  const authError: ErrorRequestHandler = (error, _request, response, next) => {
    if (response.headersSent) return next(error);
    const status =
      error.status === 413 ? 413 : error.status === 400 ? 400 : 503;
    if (status === 503) console.error("Error interno de autenticación.");
    response
      .set("Cache-Control", "no-store")
      .status(status)
      .json({
        error: status === 503 ? "temporarily_unavailable" : "invalid_request",
      });
  };
  app.use(authError);

  return requireBearerAuth({
    verifier: provider,
    expectedResource: config.resource,
    requiredScopes: [scope],
    resourceMetadataUrl,
  });
}
