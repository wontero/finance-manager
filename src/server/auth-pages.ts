import { createHash, timingSafeEqual } from "node:crypto";
import express, { type Request, type Response } from "express";
import { sql } from "kysely";
import { checkCredentials } from "./auth-credentials.js";
import type { AuthConfig } from "./auth-provider.js";
import { loginRateLimit } from "./auth-rate-limit.js";
import {
  authContext,
  authEvent,
  authTransaction,
  digest,
  loginBlocked,
  newToken,
  recordBlockedLogin,
  type AuthDb,
} from "./auth-store.js";

const cookieName = "finance_oauth";
const formToken = /^[A-Za-z0-9_-]{43}$/;
const stylesheet = `
:root{color-scheme:light;font-family:system-ui,sans-serif;background:#f4f6f4;color:#172721}
body{margin:0;padding:clamp(1rem,5vw,3rem);min-height:85vh;display:grid;place-items:center}
main{box-sizing:border-box;width:min(100%,28rem);padding:clamp(1.25rem,5vw,2rem);background:white;border:1px solid #ccd7d0;border-radius:1rem}
h1{font-size:clamp(1.45rem,5vw,1.9rem);line-height:1.2;margin:0 0 1rem;overflow-wrap:anywhere}
p{line-height:1.5;overflow-wrap:anywhere}
label{display:block;font-weight:650;margin:1rem 0 .35rem}
input:not([type=hidden]){box-sizing:border-box;width:100%;font:inherit;padding:.7rem;border:1px solid #6a8275;border-radius:.4rem}
button{font:inherit;font-weight:650;padding:.65rem .95rem;margin:.9rem .25rem .2rem 0;border:1px solid #22503e;border-radius:.4rem;background:#22503e;color:white;cursor:pointer}
button[value=deny]{background:white;color:#22503e}
:focus-visible{outline:3px solid #296cb1;outline-offset:2px}
[role=alert]{color:#912323}
`;
const styleHash = createHash("sha256").update(stylesheet).digest("base64");
const clientDate = new Intl.DateTimeFormat("es-BO", {
  timeZone: "America/La_Paz",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

type AuthRequest = {
  id: Buffer;
  csrf_hash: Buffer;
  client_id: string;
  redirect_uri: string;
  resource: string;
  oauth_state: string | null;
  metadata: string;
  client_created_at: string;
};

function escapeHtml(value: string) {
  const replacements: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, (char) => replacements[char]);
}

export function authorizationHeaders(response: Response, config: AuthConfig) {
  const redirectOrigins = [
    ...new Set(config.redirects.map((uri) => new URL(uri).origin)),
  ];
  response.set({
    "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'none'; style-src 'sha256-${styleHash}'; base-uri 'none'; form-action 'self' ${redirectOrigins.join(" ")}; frame-ancestors 'none'`,
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
}

function cookieOptions(config: AuthConfig) {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: config.secureCookies,
    path: "/authorize",
  };
}

function page(response: Response, title: string, body: string, status = 200) {
  return response.status(status).type("html").send(`<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Finance Manager</title><style>${stylesheet}</style></head>
<body><main><h1>${title}</h1>${body}</main></body></html>`);
}

export function renderLogin(
  response: Response,
  config: AuthConfig,
  browser: string,
  csrf: string,
  status = 200,
) {
  response.cookie(cookieName, browser, {
    ...cookieOptions(config),
    maxAge: 10 * 60_000,
  });
  page(
    response,
    "Inicia sesión",
    `
    ${status === 200 ? "" : '<p role="alert">No se pudo iniciar sesión. Revisa tus datos o vuelve a intentarlo más tarde.</p>'}
    <form action="/authorize/login" method="post">
      <input type="hidden" name="csrf" value="${csrf}">
      <label for="password">Contraseña</label>
      <input id="password" type="password" name="password" autocomplete="current-password" maxlength="1024" required>
      <label for="totp">Código de tu aplicación de autenticación</label>
      <input id="totp" name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>
      <button>Continuar</button>
    </form>`,
    status,
  );
}

function renderConsent(
  response: Response,
  config: AuthConfig,
  item: AuthRequest,
  browser: string,
  csrf: string,
) {
  const metadata: { client_name?: string } = JSON.parse(item.metadata);
  const name = escapeHtml(metadata.client_name || "Este cliente");
  const host = escapeHtml(new URL(item.redirect_uri).host);
  const registered = escapeHtml(
    clientDate.format(new Date(item.client_created_at.replace(" ", "T") + "Z")),
  );
  response.cookie(cookieName, browser, {
    ...cookieOptions(config),
    maxAge: 5 * 60_000,
  });
  page(
    response,
    `${name} quiere acceder a tus finanzas`,
    `
    <p><strong>Autoriza solo si acabas de iniciar la conexión desde tu Claude</strong>.</p>
    <p>Cliente registrado el ${registered} (hora de Bolivia).</p>
    <p>Si autorizas el acceso, volverás a <strong>${host}</strong>.</p>
    <form action="/authorize/consent" method="post">
      <input type="hidden" name="csrf" value="${csrf}">
      <button name="decision" value="allow">Autorizar</button>
      <button name="decision" value="deny">Cancelar</button>
    </form>`,
  );
}

function readForm(request: Request) {
  const cookies = request.headers.cookie
    ?.split(";")
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie.startsWith(`${cookieName}=`));
  const browser =
    cookies?.length === 1 ? cookies[0].slice(cookieName.length + 1) : "";
  const csrf: unknown = request.body?.csrf;
  return formToken.test(browser) &&
    typeof csrf === "string" &&
    formToken.test(csrf)
    ? { browser, csrf }
    : undefined;
}

async function getForm(
  db: AuthDb,
  config: AuthConfig,
  phase: "login" | "consent",
  browser: string,
  csrf: string,
) {
  const {
    rows: [item],
  } = await sql<AuthRequest>`
    SELECT r.id, r.csrf_hash, r.client_id, r.redirect_uri, r.resource, r.oauth_state, c.metadata, c.created_at AS client_created_at
    FROM oauth_authorization_codes r JOIN oauth_clients c ON c.id = r.client_id
    WHERE r.id = ${digest(browser)} AND r.phase = ${phase} AND r.expires_at > UTC_TIMESTAMP(3)
  `.execute(db);
  if (
    item &&
    timingSafeEqual(item.csrf_hash, digest(csrf)) &&
    item.resource === config.resource.href &&
    config.redirects.includes(item.redirect_uri)
  )
    return item;
}

export function authorizationForms(
  config: AuthConfig,
  database: AuthDb | undefined,
) {
  const router = express.Router();
  for (const path of ["/login", "/consent"]) {
    router.post(
      path,
      loginRateLimit((_request, response) => {
        page(
          response,
          "Demasiadas solicitudes",
          "<p>Vuelve a intentarlo más tarde.</p>",
          429,
        );
      }),
    );
  }
  router.use(
    express.urlencoded({ extended: false, limit: "8kb", parameterLimit: 8 }),
  );
  router.post("/login", async (request, response) => {
    const form = readForm(request);
    const invalidForm = () =>
      page(
        response,
        "Solicitud inválida",
        "<p>Vuelve a iniciar la autorización.</p>",
        403,
      );
    if (!form) return invalidForm();
    if (!database)
      return renderLogin(response, config, form.browser, form.csrf, 503);
    const original = await getForm(
      database,
      config,
      "login",
      form.browser,
      form.csrf,
    );
    if (!original) return invalidForm();
    const ip = authContext.getStore()?.ip ?? null;
    const blocked = async () => {
      await recordBlockedLogin(database, original.client_id);
      return renderLogin(response, config, form.browser, form.csrf, 429);
    };
    if (await loginBlocked(database, ip)) return blocked();
    const result = await authTransaction(database, async (db, user) => {
      const item = await getForm(db, config, "login", form.browser, form.csrf);
      if (!item) return { status: 403 } as const;
      if (await loginBlocked(db, ip)) return { status: 429 } as const;
      const password: unknown = request.body?.password;
      const token: unknown = request.body?.totp;
      const result = await checkCredentials(
        user,
        config.encryptionKey,
        typeof password === "string" && Buffer.byteLength(password) <= 1024
          ? password
          : "",
        typeof token === "string" && /^[0-9]{6}$/.test(token) ? token : "",
      );
      await authEvent(db, "login", result.outcome, item.client_id);
      if (result.outcome === "error") return { status: 503 } as const;
      if (result.outcome === "invalid") {
        await sql`INSERT INTO auth_attempts (ip) VALUES (${ip ?? ""})`.execute(
          db,
        );
        return { status: 401 } as const;
      }
      const csrf = newToken();
      await sql`UPDATE auth_users SET last_totp_step = ${result.step} WHERE id = 1`.execute(
        db,
      );
      await sql`UPDATE oauth_authorization_codes SET phase = 'consent', csrf_hash = ${digest(csrf)},
        expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 5 MINUTE) WHERE id = ${item.id}`.execute(
        db,
      );
      return { status: 200, item, csrf } as const;
    });
    if (result.status === 403) return invalidForm();
    if (result.status === 429) return blocked();
    if (result.status !== 200)
      return renderLogin(
        response,
        config,
        form.browser,
        form.csrf,
        result.status,
      );
    renderConsent(response, config, result.item, form.browser, result.csrf);
  });

  router.post("/consent", async (request, response) => {
    const form = readForm(request);
    const decision: unknown = request.body?.decision;
    const invalidForm = () =>
      page(
        response,
        "Solicitud inválida",
        "<p>Vuelve a iniciar la autorización.</p>",
        403,
      );
    if (
      !database ||
      !form ||
      (decision !== "allow" && decision !== "deny") ||
      !(await getForm(database, config, "consent", form.browser, form.csrf))
    )
      return invalidForm();
    const redirect = await authTransaction(database, async (db) => {
      const item = await getForm(
        db,
        config,
        "consent",
        form.browser,
        form.csrf,
      );
      if (!item) return;
      const url = new URL(item.redirect_uri);
      if (item.oauth_state !== null)
        url.searchParams.set("state", item.oauth_state);
      if (decision === "deny") {
        await sql`DELETE FROM oauth_authorization_codes WHERE id = ${item.id}`.execute(
          db,
        );
        url.searchParams.set("error", "access_denied");
      } else {
        const code = newToken();
        await sql`UPDATE oauth_authorization_codes SET phase = 'code', csrf_hash = NULL,
          code_hash = ${digest(code)}, expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 5 MINUTE)
          WHERE id = ${item.id}`.execute(db);
        url.searchParams.set("code", code);
      }
      return url.href;
    });
    if (!redirect) return invalidForm();
    response
      .clearCookie(cookieName, cookieOptions(config))
      .redirect(303, redirect);
  });
  return router;
}
