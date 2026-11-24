export function setting(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Configura ${name} en .env`);
  return value;
}

export function localDatabase(name: string) {
  const value = setting(name);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Configura una URL válida en ${name}`);
  }
  const port = Number(url.port);
  if (
    url.protocol !== "mysql:" ||
    url.hostname !== "127.0.0.1" ||
    port < 3308 ||
    port > 65535 ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `${name} requiere una URL mysql:// en 127.0.0.1 con puerto entre 3308 y 65535, sin parámetros ni fragmento`,
    );
  }
  return {
    host: url.hostname,
    port,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)) || undefined,
    connectTimeout: 1500,
  };
}
