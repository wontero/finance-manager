import express from "express";
import request from "supertest";
import { expect, test, vi } from "vitest";
import { createApp } from "./app.js";
import { readConfig } from "./config.js";

const publicUrl = "https://finanzas.example";
const app = request(createApp(readConfig({ PUBLIC_URL: publicUrl })));
const passengerHeader = "!~Passenger-Client-Address";

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

test("M-005C S21: Passenger ignores the header on non-loopback TCP and warns once", async () => {
  vi.resetModules();
  const { createApp: freshApp } = await import("./app.js");
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const passenger = readConfig({
    PUBLIC_URL: publicUrl,
    TRUST_PROXY: "passenger",
  });
  const tcpApp = () =>
    request(
      express().use((req, _res, next) => {
        Object.defineProperty(req.socket, "remoteAddress", {
          value: "192.0.2.21",
        });
        next();
      }, freshApp(passenger)),
    );
  try {
    for (const client of [tcpApp(), tcpApp()]) {
      await client
        .get("/health")
        .set(passengerHeader, "203.0.113.21")
        .expect(200);
    }
    expect(info).toHaveBeenCalledExactlyOnceWith(
      "Diagnóstico de IP de Passenger",
      expect.objectContaining({
        remoteAddress: "192.0.2.21",
        passengerHeader: true,
        ip: null,
      }),
    );
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/Passenger.*ignor/i),
    );
  } finally {
    info.mockRestore();
    warn.mockRestore();
  }
});

test("M-005C S21: Passenger accepts the header on a local socket without TCP metadata", async () => {
  vi.resetModules();
  const { createApp: freshApp } = await import("./app.js");
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const config = readConfig({
    PUBLIC_URL: publicUrl,
    TRUST_PROXY: "passenger",
  });
  const local = request(
    express().use((req, _res, next) => {
      Object.defineProperties(req.socket, {
        remoteAddress: { value: undefined },
        remoteFamily: { value: undefined },
        localAddress: { value: undefined },
      });
      next();
    }, freshApp(config)),
  );
  try {
    await local.get("/health").set(passengerHeader, "203.0.113.21").expect(200);
    expect(info).toHaveBeenCalledExactlyOnceWith(
      "Diagnóstico de IP de Passenger",
      expect.objectContaining({
        remoteAddress: null,
        passengerHeader: true,
        ip: "203.0.113.21",
      }),
    );
  } finally {
    info.mockRestore();
  }
});

test.each([
  ["/register", 20],
  ["/authorize", 100],
  ["/revoke", 50],
] as const)("M-005C: %s separates Passenger IP quotas", async (path, limit) => {
  const browser = request(
    createApp(readConfig({ PUBLIC_URL: publicUrl, TRUST_PROXY: "passenger" })),
  );
  const send = () =>
    path === "/authorize" ? browser.get(path) : browser.post(path).type("form");
  for (let i = 0; i < limit; i++)
    await send().set(passengerHeader, "203.0.113.22").expect(400);
  await send().set(passengerHeader, "203.0.113.22").expect(429);
  await send().set(passengerHeader, "203.0.113.23").expect(400);
  if (path !== "/revoke") {
    for (let i = 0; i < limit; i++) await send().expect(400);
    await send().expect(429);
  }
});
