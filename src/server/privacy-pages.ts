import type { Express, Response } from "express";
import { sql } from "kysely";
import { authorizationHeaders, escapeHtml, page } from "./auth-pages.js";
import type { AuthConfig } from "./auth-provider.js";
import type { AuthDb } from "./auth-store.js";
import { webSession } from "./web-session.js";

type Channel = "mcp" | "api";

export function countRequests(db: AuthDb | undefined, channel: Channel) {
  return (_request: unknown, response: Response, next: () => void) => {
    if (db)
      response.once("finish", () => {
        void sql`INSERT INTO request_metrics (day, channel, status_class, requests)
        VALUES (UTC_DATE(), ${channel}, ${Math.floor(response.statusCode / 100)}, 1)
        ON DUPLICATE KEY UPDATE requests = requests + 1`
          .execute(db)
          .catch(() => {
            console.error("No se pudo registrar una petición en las métricas.");
          });
      });
    next();
  };
}

type Totals = {
  total: string;
  week: string;
  month: string;
  active: string;
  today: string;
};
type Daily = {
  day: string;
  channel: Channel;
  total: string;
  client_errors: string | null;
  server_errors: string | null;
};

function dailyCells(count?: Daily) {
  const total = Number(count?.total ?? 0);
  const percent = (errors: string | null = null) =>
    (total ? (100 * Number(errors ?? 0)) / total : 0).toFixed(2) + " %";
  return `<td>${count?.total ?? 0}</td><td>${percent(count?.client_errors)}</td><td>${percent(count?.server_errors)}</td>`;
}

export function installPrivacyPages(
  app: Express,
  config: AuthConfig,
  {
    operatorName,
    operatorContact,
    metricsEmail,
  }: {
    operatorName: string;
    operatorContact: string;
    metricsEmail?: string;
  },
  db?: AuthDb,
) {
  app.get("/privacidad", (_request, response) => {
    authorizationHeaders(response, config);
    page(
      response,
      "Privacidad y términos",
      `
      <p><strong>${escapeHtml(operatorName)}</strong> administra el servidor de esta instancia. Contacto: ${escapeHtml(operatorContact)}.</p>
      <p>Guardamos tu perfil de Google, los datos financieros que registras, el historial de cambios y los datos de acceso. Los registros de autenticación pueden incluir la IP y el navegador.</p>
      <p>Finance Manager es un proyecto personal que se ofrece sin garantía.</p>
      <p>Si conectas Claude, puede leer los datos que le pidas consultar.</p>
      <p>En Cuenta, usa <strong>Exportar mis datos</strong> para descargar un JSON o <strong>Borrar mi cuenta</strong> para eliminar tus datos del servidor. Las copias de seguridad cifradas conservan los datos borrados hasta que caducan.</p>
      <p><a href="/">Volver a Finance Manager</a></p>`,
    );
  });

  const session = webSession(config.secureCookies);
  app.get("/metricas", async (request, response) => {
    authorizationHeaders(response, config);
    const active = db && metricsEmail && (await session.find(db, request));
    if (!db || !active || active.verifiedEmail !== metricsEmail)
      return response.sendStatus(404);
    const {
      rows: [users],
    } = await sql<Totals>`
      SELECT UTC_DATE() AS today, COUNT(*) AS total,
        COUNT(CASE WHEN created_at >= UTC_TIMESTAMP(3) - INTERVAL 7 DAY THEN 1 END) AS week,
        COUNT(CASE WHEN created_at >= UTC_TIMESTAMP(3) - INTERVAL 30 DAY THEN 1 END) AS month,
        COUNT(CASE WHEN last_seen_at >= UTC_TIMESTAMP(3) - INTERVAL 7 DAY THEN 1 END) AS active
      FROM users
    `.execute(db);
    const { rows } = await sql<Daily>`
      SELECT day, channel, SUM(requests) AS total,
        SUM(CASE WHEN status_class = 4 THEN requests ELSE 0 END) AS client_errors,
        SUM(CASE WHEN status_class = 5 THEN requests ELSE 0 END) AS server_errors
      FROM request_metrics
      WHERE day BETWEEN DATE_SUB(${users.today}, INTERVAL 29 DAY) AND ${users.today}
      GROUP BY day, channel
    `.execute(db);
    const days = new Map(rows.map((row) => [row.day + row.channel, row]));
    const today = Date.parse(users.today + "T00:00:00Z");
    const daily = Array.from({ length: 30 }, (_, i) => {
      const day = new Date(today - i * 86_400_000).toISOString().slice(0, 10);
      return `<tr><th scope="row">${day}</th>${dailyCells(days.get(day + "mcp"))}${dailyCells(days.get(day + "api"))}</tr>`;
    }).join("");
    return page(
      response,
      "Métricas",
      `
      <dl><dt>Usuarios totales</dt><dd>${users.total}</dd><dt>Altas en 7 días</dt><dd>${users.week}</dd>
      <dt>Altas en 30 días</dt><dd>${users.month}</dd><dt>Usuarios activos en 7 días</dt><dd>${users.active}</dd></dl>
      <h2 id="requests">Peticiones de los últimos 30 días</h2>
      <div class="metrics" role="region" aria-labelledby="requests" tabindex="0"><table aria-label="Peticiones y tasas de error por día UTC">
        <thead><tr><th scope="col" rowspan="2">Día UTC</th><th scope="colgroup" colspan="3">MCP</th><th scope="colgroup" colspan="3">API</th></tr>
        <tr><th scope="col">Peticiones</th><th scope="col">4xx</th><th scope="col">5xx</th><th scope="col">Peticiones</th><th scope="col">4xx</th><th scope="col">5xx</th></tr></thead>
        <tbody>${daily}</tbody>
      </table></div>
      <p><a href="/">Volver al dashboard</a></p>`,
    );
  });
}
