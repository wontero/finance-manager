import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout } from "node:timers/promises";
import { expect, test } from "vitest";

test.each([
  ["node app.js", ["app.js"]],
  [
    "Passenger require()",
    ["--no-experimental-require-module", "-e", "require('./app.js')"],
  ],
])("S8: %s starts the built app", async (_loader, args) => {
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const child = spawn(process.execPath, args, {
    env: { ...process.env, PORT: String(address.port), APP_VERSION: "s8" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const closed = once(child, "close");
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (message) => (stderr += message));
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (child.exitCode !== null) break;
      const response = await fetch(
        `http://127.0.0.1:${address.port}/health`,
      ).catch(() => undefined);
      if (response) {
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          status: "ok",
          version: "s8",
        });
        const web = await fetch(`http://127.0.0.1:${address.port}/`);
        expect(web.status).toBe(200);
        expect(await web.text()).toContain('<div id="root"></div>');
        return;
      }
      await setTimeout(75);
    }
    throw new Error(`El servidor no arrancó: ${stderr}`);
  } finally {
    child.kill();
    await closed;
  }
});

test.each([
  ["PORT", "abc", /PORT debe ser un entero/],
  [
    "DATABASE_URL",
    "https://user:secret@localhost",
    /DATABASE_URL debe ser una URL mysql/,
  ],
])("S7: node app.js stops on invalid %s", async (name, value, message) => {
  const child = spawn(process.execPath, ["app.js"], {
    env: { ...process.env, [name]: value },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  try {
    const [exitCode] = await once(child, "close");
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(message);
    expect(stderr).not.toContain("secret");
  } finally {
    if (child.exitCode === null) child.kill();
  }
});
