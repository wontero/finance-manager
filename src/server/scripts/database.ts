import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import mariadb from "mariadb";
import { localDatabase, setting } from "./local-database.js";

function isListening(port: number) {
  return new Promise<boolean>((finish) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.on("error", () => finish(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      finish(false);
    });
    socket.once("connect", () => {
      socket.destroy();
      finish(true);
    });
  });
}

async function manageDatabase(action: string) {
  const database = localDatabase("DATABASE_URL");
  const { port } = database;
  const dataDir = await realpath(setting("MARIADB_DATA_DIR"));
  const alreadyListening = await isListening(port);

  if (action === "stop" && !alreadyListening) {
    console.log("MariaDB local ya está detenida.");
    return;
  }

  if (action === "start" && !alreadyListening) {
    const home = resolve(setting("MARIADB_HOME"));
    const log = join(dataDir, "mariadb.log");
    const server = spawn(
      join(home, "bin", "mariadbd.exe"),
      [
        "--no-defaults",
        `--basedir=${home}`,
        `--datadir=${dataDir}`,
        "--bind-address=127.0.0.1",
        `--port=${port}`,
        "--skip-name-resolve",
        `--log-error=${log}`,
      ],
      { windowsHide: true, detached: true, stdio: "ignore" },
    );
    await new Promise<void>((ready, fail) => {
      server.once("spawn", ready);
      server.once("error", fail);
    });
    server.unref();
    for (let tries = 0; !(await isListening(port)); tries++) {
      if (server.exitCode !== null || tries >= 80) {
        throw new Error(`MariaDB no inició. Consulta ${log}`);
      }
      await delay(250);
    }
  }

  const credentials =
    action === "stop" ? localDatabase("MARIADB_SHUTDOWN_URL") : database;
  if (credentials.port !== port) {
    throw new Error(
      "DATABASE_URL y MARIADB_SHUTDOWN_URL deben usar el mismo puerto",
    );
  }

  const connection = await mariadb.createConnection(credentials).catch(() => {
    throw new Error(
      `No se pudo autenticar en MariaDB local (puerto ${port}). Comprueba .env`,
    );
  });
  try {
    const [row] = await connection.query("SELECT @@datadir AS dataDir");
    if (resolve(row.dataDir).toLowerCase() !== resolve(dataDir).toLowerCase()) {
      throw new Error(
        `El puerto ${port} pertenece a otra instancia de MariaDB`,
      );
    }
    if (action === "stop") await connection.query("SHUTDOWN");
  } finally {
    await connection.end();
  }

  if (action === "stop") {
    for (let tries = 0; await isListening(port); tries++) {
      if (tries >= 40) throw new Error(`El puerto ${port} sigue abierto`);
      await delay(250);
    }
    console.log("MariaDB local detenida.");
  } else {
    console.log(`MariaDB local disponible en 127.0.0.1:${port}.`);
  }
}

const action = process.argv[2];
if (action !== "start" && action !== "stop")
  throw new Error("Usa start o stop");

await manageDatabase(action);
