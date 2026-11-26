import { createHash, timingSafeEqual } from "node:crypto";
import express, { type Request, type Response } from "express";
import { sql } from "kysely";
import { googleLogin, resolveGoogleUser } from "./auth-google.js";
import type { AuthConfig } from "./auth-provider.js";
import { loginRateLimit } from "./auth-rate-limit.js";
import {
  authEvent,
  authTransaction,
  digest,
  newToken,
  readCookie,
  type AuthDb,
} from "./auth-store.js";
import { webSession } from "./web-session.js";

const cookieName = (config: AuthConfig) =>
  config.secureCookies ? "__Host-fm-oauth" : "fm-oauth";
const formToken = /^[A-Za-z0-9_-]{43}$/;
const stylesheet = `
:root{color-scheme:light;font-family:system-ui,sans-serif;background:#f4f6f4;color:#172721}
body{margin:0;padding:clamp(1rem,5vw,3rem);min-height:85vh;display:grid;place-items:center}
main{box-sizing:border-box;width:min(100%,28rem);padding:clamp(1.25rem,5vw,2rem);background:white;border:1px solid #ccd7d0;border-radius:1rem}
h1{font-size:clamp(1.45rem,5vw,1.9rem);line-height:1.2;margin:0 0 1rem;overflow-wrap:anywhere}
p{line-height:1.5;overflow-wrap:anywhere}
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
  user_id: string | null;
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
  if (config.google)
    redirectOrigins.push(config.google.authorizationUrl.origin);
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
    path: "/",
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
) {
  response.cookie(cookieName(config), browser, {
    ...cookieOptions(config),
    maxAge: 10 * 60_000,
  });
  page(
    response,
    "Inicia sesión",
    `<form action="/authorize/google" method="post">
      <input type="hidden" name="csrf" value="${csrf}">
      <button>Iniciar sesión con Google</button>
    </form>`,
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
  response.cookie(cookieName(config), browser, {
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

function readForm(request: Request, config: AuthConfig) {
  const browser = readCookie(request, cookieName(config));
  const csrf: unknown = request.body?.csrf;
  return browser && typeof csrf === "string" && formToken.test(csrf)
    ? { browser, csrf }
    : undefined;
}

async function getForm(
  db: AuthDb,
  config: AuthConfig,
  phase: "login" | "consent",
  browser: string,
  csrf?: string,
) {
  const {
    rows: [item],
  } = await sql<AuthRequest>`
    SELECT r.id, r.csrf_hash, r.user_id, r.client_id, r.redirect_uri, r.resource, r.oauth_state, c.metadata, c.created_at AS client_created_at
    FROM oauth_authorization_codes r JOIN oauth_clients c ON c.id = r.client_id
    WHERE r.id = ${digest(browser)} AND r.phase = ${phase} AND r.expires_at > UTC_TIMESTAMP(3)
  `.execute(db);
  if (
    item &&
    (csrf === undefined || timingSafeEqual(item.csrf_hash, digest(csrf))) &&
    item.resource === config.resource.href &&
    config.redirects.includes(item.redirect_uri)
  )
    return item;
}

const invalidForm = (response: Response) =>
  page(
    response,
    "Solicitud inválida",
    "<p>Vuelve a iniciar la autorización.</p>",
    403,
  );

const rateLimited = (_request: Request, response: Response) =>
  page(
    response,
    "Demasiadas solicitudes",
    "<p>Vuelve a intentarlo más tarde.</p>",
    429,
  );

export function googleForms(config: AuthConfig, database: AuthDb | undefined) {
  const router = express.Router();
  const google = database && config.google && googleLogin(config, database);
  const session = webSession(config.secureCookies);
  router.get(
    "/start",
    loginRateLimit(rateLimited),
    async (_request, response) => {
      if (!google)
        return page(response, "Inicio de sesión no disponible", "", 503);
      await google.start(response);
    },
  );
  router.get(
    "/callback",
    loginRateLimit(rateLimited),
    async (request, response) => {
      if (!database || !google || !config.google) return invalidForm(response);
      const result = await google.finish(request, response);
      if (!result) {
        await authEvent(database, "login", "invalid");
        return invalidForm(response);
      }
      const { oauthBrowser, identity } = result;
      const login = await authTransaction(database, async (db) => {
        const item =
          oauthBrowser && (await getForm(db, config, "login", oauthBrowser));
        if (oauthBrowser && !item) return;
        const userId = await resolveGoogleUser(db, config.google!, identity);
        if (!userId) {
          await authEvent(db, "login", "blocked", item ? item.client_id : null);
          return null;
        }
        await authEvent(db, "login", "success", item ? item.client_id : null);
        if (!item) return { token: await session.create(db, userId) } as const;
        const csrf = newToken();
        await sql`UPDATE oauth_authorization_codes SET phase = 'consent', user_id = ${userId},
        csrf_hash = ${digest(csrf)}, expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 5 MINUTE)
        WHERE id = ${item.id}`.execute(db);
        return { item, csrf } as const;
      });
      if (login === undefined) return invalidForm(response);
      if (!login)
        return page(
          response,
          "Registro cerrado",
          "<p>No hay cupo para nuevas cuentas.</p>",
          403,
        );
      if (login.token !== undefined) {
        session.attach(response, login.token);
        response.redirect(303, "/");
      } else {
        renderConsent(response, config, login.item, oauthBrowser!, login.csrf);
      }
    },
  );
  return router;
}

export function authorizationForms(
  config: AuthConfig,
  database: AuthDb | undefined,
) {
  const router = express.Router();
  router.use(
    express.urlencoded({ extended: false, limit: "8kb", parameterLimit: 8 }),
  );
  router.post(
    "/google",
    loginRateLimit(rateLimited),
    async (request, response) => {
      const form = readForm(request, config);
      if (
        !database ||
        !config.google ||
        !form ||
        !(await getForm(database, config, "login", form.browser, form.csrf))
      )
        return invalidForm(response);
      await googleLogin(config, database).start(response, form.browser);
    },
  );

  router.post(
    "/consent",
    loginRateLimit(rateLimited),
    async (request, response) => {
      const form = readForm(request, config);
      const decision: unknown = request.body?.decision;
      if (
        !database ||
        !form ||
        (decision !== "allow" && decision !== "deny") ||
        !(await getForm(database, config, "consent", form.browser, form.csrf))
      )
        return invalidForm(response);
      const redirect = await authTransaction(database, async (db) => {
        const item = await getForm(
          db,
          config,
          "consent",
          form.browser,
          form.csrf,
        );
        if (!item?.user_id) return;
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
      if (!redirect) return invalidForm(response);
      response
        .clearCookie(cookieName(config), cookieOptions(config))
        .redirect(303, redirect);
    },
  );
  return router;
}
