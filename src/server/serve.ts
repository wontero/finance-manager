import { APP_NAME } from "@finance-manager/core";
import { createApp } from "./app.js";
import { readConfig } from "./config.js";

export function start(release?: string) {
  const config = readConfig(process.env);
  createApp(
    config,
    /^\d{8}-\d{6}$/.test(release ?? "") ? release : undefined,
  ).listen(config.port, () =>
    console.log(`${APP_NAME}: puerto ${config.port}`),
  );
}
