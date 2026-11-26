import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { sql } from "kysely";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
  ServerError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { readConfig } from "./config.js";
import { renderLogin } from "./auth-pages.js";
import {
  authEvent,
  authTransaction,
  digest,
  newToken,
  purgeAuth,
  revokeFamily,
  type AuthDb,
} from "./auth-store.js";

export type AuthConfig = ReturnType<typeof readConfig>["auth"];
type Client = OAuthClientInformationFull;
export const scope = "finance";
const invalidGrant = () =>
  new InvalidGrantError("Concesión inválida o vencida");
const opaqueToken = /^[A-Za-z0-9_-]{43}$/;
const clientId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const accessSeconds = 3600;

type AuthorizationCode = {
  id: Buffer;
  user_id: string;
  code_challenge: Buffer;
  phase: "code" | "used";
  redirect_uri: string;
  resource: string;
};

type RefreshToken = {
  family_id: Buffer;
  user_id: string;
  family_expires_at: string;
  rotated_at: string | null;
  revoked_at: string | null;
  active: number;
};

export class FinanceOAuthProvider implements OAuthServerProvider {
  constructor(
    readonly config: AuthConfig,
    private readonly database: AuthDb | undefined,
  ) {}

  private get db() {
    if (!this.database || !this.config.google)
      throw new ServerError("Autenticación pendiente de configuración");
    return this.database;
  }

  readonly clientsStore: OAuthRegisteredClientsStore = {
    getClient: async (id) => {
      if (!clientId.test(id)) return undefined;
      const {
        rows: [row],
      } = await sql<{ metadata: string }>`
        SELECT metadata FROM oauth_clients WHERE id = ${id}
      `.execute(this.db);
      if (!row) return undefined;
      const metadata: Client = JSON.parse(row.metadata);
      return metadata.redirect_uris.every((uri) =>
        this.config.redirects.includes(uri),
      )
        ? metadata
        : undefined;
    },
    registerClient: async (client) => {
      const grants = client.grant_types ?? ["authorization_code"];
      const responses = client.response_types ?? ["code"];
      if (
        client.token_endpoint_auth_method !== "none" ||
        client.client_secret !== undefined ||
        !client.redirect_uris.length ||
        !client.redirect_uris.every((uri) =>
          this.config.redirects.includes(uri),
        ) ||
        !grants.includes("authorization_code") ||
        grants.some(
          (grant) =>
            grant !== "authorization_code" && grant !== "refresh_token",
        ) ||
        responses.length !== 1 ||
        responses[0] !== "code" ||
        (client.scope !== undefined && client.scope !== scope)
      )
        throw new InvalidClientMetadataError(
          "Registra un cliente público con URLs de retorno autorizadas",
        );
      const metadata: Client = {
        client_id: randomUUID(),
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: client.client_name?.slice(0, 100),
        redirect_uris: client.redirect_uris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope,
      };
      await sql`INSERT INTO oauth_clients (id, metadata)
        VALUES (${metadata.client_id}, ${JSON.stringify(metadata)})`.execute(
        this.db,
      );
      return metadata;
    },
  };

  private checkResource(resource: URL | undefined) {
    if (resource && resource.href !== this.config.resource.href)
      throw new InvalidTargetError("Recurso inválido");
  }

  private checkScope(scopes: string[] = []) {
    if (scopes.length && (scopes.length !== 1 || scopes[0] !== scope))
      throw new InvalidScopeError("Ámbito inválido");
  }

  async authorize(
    client: Client,
    params: AuthorizationParams,
    response: Response,
  ) {
    this.checkScope(params.scopes);
    this.checkResource(params.resource);
    if (
      !opaqueToken.test(params.codeChallenge) ||
      (params.state?.length ?? 0) > 2048
    )
      throw new InvalidRequestError("Solicitud de autorización inválida");
    const browser = newToken();
    const csrf = newToken();
    await sql`INSERT INTO oauth_authorization_codes
      (id, csrf_hash, phase, client_id, redirect_uri, resource, oauth_state, code_challenge, expires_at)
      VALUES (${digest(browser)}, ${digest(csrf)}, 'login', ${client.client_id}, ${params.redirectUri},
        ${this.config.resource.href}, ${params.state ?? null}, ${Buffer.from(params.codeChallenge, "base64url")},
        DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 10 MINUTE))
    `.execute(this.db);
    renderLogin(response, this.config, browser, csrf);
  }

  private async authorizationCode(db: AuthDb, client: Client, code: string) {
    if (!opaqueToken.test(code)) throw invalidGrant();
    const {
      rows: [row],
    } = await sql<AuthorizationCode>`
      SELECT id, user_id, code_challenge, phase, redirect_uri, resource FROM oauth_authorization_codes
      WHERE code_hash = ${digest(code)} AND client_id = ${client.client_id}
        AND user_id IS NOT NULL AND phase IN ('code', 'used')
        AND (expires_at > UTC_TIMESTAMP(3) OR phase = 'used')
    `.execute(db);
    if (!row) throw invalidGrant();
    return row;
  }

  async challengeForAuthorizationCode(client: Client, code: string) {
    // The SDK verifies S256 before calling exchangeAuthorizationCode.
    return (
      await this.authorizationCode(this.db, client, code)
    ).code_challenge.toString("base64url");
  }

  async exchangeAuthorizationCode(
    client: Client,
    code: string,
    _verifier?: string,
    redirect?: string,
    resource?: URL,
  ) {
    this.checkResource(resource);
    const tokens = await authTransaction(this.db, async (db) => {
      const row = await this.authorizationCode(db, client, code);
      if (
        redirect !== row.redirect_uri ||
        row.resource !== this.config.resource.href
      )
        throw invalidGrant();
      if (row.phase === "used") {
        await revokeFamily(db, row.id, row.user_id);
        await authEvent(db, "issue", "replay", client.client_id, row.user_id);
        return null;
      }
      await sql`UPDATE oauth_authorization_codes SET phase = 'used' WHERE id = ${row.id}`.execute(
        db,
      );
      const issued = await this.issueTokens(db, client, row.id, row.user_id);
      await authEvent(db, "issue", "success", client.client_id, row.user_id);
      return issued;
    });
    if (!tokens) throw invalidGrant();
    return tokens;
  }

  async exchangeRefreshToken(
    client: Client,
    refresh: string,
    scopes?: string[],
    resource?: URL,
  ) {
    this.checkScope(scopes);
    this.checkResource(resource);
    if (!opaqueToken.test(refresh)) throw invalidGrant();
    const hash = digest(refresh);
    const tokens = await authTransaction(this.db, async (db) => {
      const {
        rows: [row],
      } = await sql<RefreshToken>`
        SELECT family_id, user_id, family_expires_at, rotated_at, revoked_at,
          (expires_at > UTC_TIMESTAMP(3) AND family_expires_at > UTC_TIMESTAMP(3)) AS active
        FROM oauth_tokens WHERE token_hash = ${hash} AND token_type = 'refresh'
          AND client_id = ${client.client_id} AND resource = ${this.config.resource.href}
      `.execute(db);
      if (row?.rotated_at) {
        await revokeFamily(db, row.family_id, row.user_id);
        await authEvent(db, "refresh", "replay", client.client_id, row.user_id);
        return null;
      }
      if (!row?.active || row.revoked_at) {
        await authEvent(
          db,
          "refresh",
          "invalid",
          client.client_id,
          row?.user_id,
        );
        return null;
      }
      await sql`UPDATE oauth_tokens SET rotated_at = UTC_TIMESTAMP(3), revoked_at = UTC_TIMESTAMP(3)
        WHERE token_hash = ${hash}`.execute(db);
      const issued = await this.issueTokens(
        db,
        client,
        row.family_id,
        row.user_id,
        row.family_expires_at,
      );
      await authEvent(db, "refresh", "success", client.client_id, row.user_id);
      return issued;
    });
    if (!tokens) throw invalidGrant();
    return tokens;
  }

  private async issueTokens(
    db: AuthDb,
    client: Client,
    family: Buffer,
    userId: string,
    deadline?: string,
  ) {
    const access = newToken();
    const refresh = newToken();
    const familyExpiry =
      deadline === undefined
        ? sql`DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 90 DAY)`
        : sql`${deadline}`;
    await sql`INSERT INTO oauth_tokens
      (token_hash, token_type, family_id, user_id, client_id, resource, expires_at, family_expires_at) VALUES
      (${digest(access)}, 'access', ${family}, ${userId}, ${client.client_id}, ${this.config.resource.href},
        LEAST(DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${accessSeconds} SECOND), ${familyExpiry}), ${familyExpiry}),
      (${digest(refresh)}, 'refresh', ${family}, ${userId}, ${client.client_id}, ${this.config.resource.href},
        LEAST(DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 30 DAY), ${familyExpiry}), ${familyExpiry})
    `.execute(db);
    await purgeAuth(db);
    const expiresIn =
      deadline === undefined
        ? accessSeconds
        : Math.max(
            0,
            Math.min(
              accessSeconds,
              Math.floor(
                (Date.parse(deadline.replace(" ", "T") + "Z") - Date.now()) /
                  1000,
              ),
            ),
          );
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      scope,
      expires_in: expiresIn,
    };
  }

  async verifyAccessToken(token: string) {
    if (!opaqueToken.test(token) || !this.database || !this.config.google)
      throw new InvalidTokenError("Token inválido");
    const {
      rows: [row],
    } = await sql<{
      user_id: string;
      client_id: string;
      expires_at: string;
      resource: string;
    }>`
      SELECT t.user_id, t.client_id, t.expires_at, t.resource FROM oauth_tokens t
      WHERE t.token_hash = ${digest(token)} AND t.token_type = 'access' AND t.revoked_at IS NULL
        AND t.expires_at > UTC_TIMESTAMP(3) AND t.family_expires_at > UTC_TIMESTAMP(3)
        AND t.resource = ${this.config.resource.href}
    `.execute(this.database);
    if (!row || row.resource !== this.config.resource.href)
      throw new InvalidTokenError("Token inválido");
    return {
      token,
      userId: row.user_id,
      extra: { userId: row.user_id },
      clientId: row.client_id,
      scopes: [scope],
      expiresAt: Date.parse(row.expires_at.replace(" ", "T") + "Z") / 1000,
      resource: this.config.resource,
    };
  }

  async revokeToken(client: Client, { token }: OAuthTokenRevocationRequest) {
    if (!opaqueToken.test(token)) return;
    await authTransaction(this.db, async (db) => {
      const {
        rows: [row],
      } = await sql<{ family_id: Buffer; user_id: string }>`
        SELECT family_id, user_id FROM oauth_tokens
        WHERE token_hash = ${digest(token)} AND client_id = ${client.client_id}
      `.execute(db);
      if (row) await revokeFamily(db, row.family_id, row.user_id);
      await authEvent(
        db,
        "revoke",
        row ? "success" : "invalid",
        client.client_id,
        row?.user_id,
      );
    });
  }
}
