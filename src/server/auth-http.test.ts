import request from "supertest";
import { expect, test } from "vitest";
import { createApp } from "./app.js";
import { readConfig } from "./config.js";

const publicUrl = "https://finanzas.example";
const app = request(createApp(readConfig({ PUBLIC_URL: publicUrl })));

test("M-005 S1: the MCP challenge points to the configured resource", async () => {
  const response = await app.post("/mcp").expect(401);
  expect(response.headers["www-authenticate"]).toContain(
    `resource_metadata="${publicUrl}/.well-known/oauth-protected-resource/mcp"`,
  );
  await app.get("/health").expect(200);
});

test("M-005 S2: discovery advertises only the implemented grants and public clients", async () => {
  const response = await app
    .get("/.well-known/oauth-authorization-server")
    .expect(200);
  expect(response.body).toMatchObject({
    issuer: `${publicUrl}/`,
    authorization_endpoint: `${publicUrl}/authorize`,
    token_endpoint: `${publicUrl}/token`,
    registration_endpoint: `${publicUrl}/register`,
    revocation_endpoint: `${publicUrl}/revoke`,
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["finance"],
  });
  for (const suffix of ["", "/mcp"]) {
    const resource = await app
      .get(`/.well-known/oauth-protected-resource${suffix}`)
      .expect(200);
    expect(resource.body).toMatchObject({
      resource: `${publicUrl}/mcp`,
      authorization_servers: [`${publicUrl}/`],
      scopes_supported: ["finance"],
    });
  }
});

test.each(["https://finanzas.example/#", "https://finanzas.example/?"])(
  "M-005 S2: the issuer rejects a query or fragment delimiter, including %s",
  (PUBLIC_URL) => {
    expect(() => readConfig({ PUBLIC_URL })).toThrow(/PUBLIC_URL/);
  },
);
