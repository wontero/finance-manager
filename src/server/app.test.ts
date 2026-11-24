import request from "supertest";
import { expect, test } from "vitest";
import { APP_NAME } from "@finance-manager/core";
import { app } from "./app.js";

test("GET /health returns the status and the name from core", async () => {
  const response = await request(app).get("/health");

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ status: "ok", app: "Finance Manager" });
  expect(response.body.app).toBe(APP_NAME);
});
