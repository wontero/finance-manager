#!/usr/bin/env bash
set -euo pipefail
umask 022
export LC_ALL=C
export PATH="${DEPLOY_NODE_BIN:-/opt/cpanel/ea-nodejs22/bin}:$PATH"

fail() { printf '%s\n' "$*" >&2; exit 1; }

root=$(realpath -m "${DEPLOY_ROOT:-$HOME/apps/finanzasmateo}")
releases=$(realpath -m "${DEPLOY_RELEASES_DIR:-$root/releases}")
shared=$(realpath -m "${DEPLOY_SHARED_DIR:-$root/shared}")
repo=$(realpath -m "${DEPLOY_REPO_DIR:-$root/repo}")
repo_url=${DEPLOY_REPO_URL:-git@github.com:wontero/finance-manager.git}
health_url=${DEPLOY_HEALTH_URL:-https://finanzasmateo.ingetech.biz/health}
health_attempts=${DEPLOY_HEALTH_ATTEMPTS:-10}
health_delay=${DEPLOY_HEALTH_DELAY:-3}
current="$root/current"
previous="$shared/previous"
lock="$root/.deploy.lock"
staged=
switching=0

usage='Uso: deploy.sh [ref | --bootstrap | --rollback [--yes]]'
[[ $# -le 1 || ( $# -eq 2 && $1 == --rollback && $2 == --yes ) ]] || fail "$usage"
mode=${1:-main}
case "$mode" in
  --bootstrap|--rollback) ;;
  -*) fail "$usage" ;;
esac
[[ $health_attempts =~ ^[1-9][0-9]*$ && $health_delay =~ ^(0|[1-9][0-9]*)$ ]] ||
  fail 'Configura DEPLOY_HEALTH_ATTEMPTS (>0) y DEPLOY_HEALTH_DELAY (>=0) como enteros.'

reject_active_bootstrap() {
  [[ $mode != --bootstrap || ! -L $current || ! -d $current ]] ||
    fail 'La aplicación ya tiene una release activa.'
}

[[ -e $lock ]] || reject_active_bootstrap
mkdir -p -- "$root"
exec 9<>"$lock"
flock -n 9 || fail 'Ya hay un despliegue en curso.'

release_path() {
  [[ ${1%/*} == "$releases" && ${1##*/} =~ ^[0-9]{8}-[0-9]{6}$ && -d $1 && ! -L $1 ]]
}

active=$(readlink -- "$current" || true)
prior=$(readlink -- "$previous" || true)
for link in "$current" "$previous"; do
  [[ ! -e $link || -L $link ]] || fail 'current y previous deben ser enlaces del despliegue.'
done
if [[ -n $active ]]; then
  release_path "$active" || fail 'current no apunta a una release válida.'
fi
if [[ -n $prior ]]; then
  release_path "$prior" || fail 'previous no apunta a una release válida.'
fi
reject_active_bootstrap

if [[ $mode == --rollback ]]; then
  [[ -n $active && -n $prior && $active != "$prior" ]] || fail 'No hay una release anterior para restaurar.'
  echo "Rollback de ${active##*/} a ${prior##*/}."
  if [[ ${2:-} != --yes ]]; then
    [[ -t 0 ]] || fail 'Confirma el rollback en una terminal o pasa --yes.'
    read -r -p '¿Confirmas el rollback? [s/N] ' answer && [[ $answer == [sS] ]] ||
      fail 'Rollback cancelado.'
  fi
fi

require_db=false
if [[ $mode != --rollback || -e $shared/.env ]]; then
  [[ -r $shared/.env ]] || fail 'Prepara shared/.env antes de desplegar.'
  require_db=$(node -e '
    const { readFileSync } = require("node:fs");
    const { parseEnv } = require("node:util");
    console.log(Object.hasOwn(parseEnv(readFileSync(process.argv[1], "utf8")), "DATABASE_URL"));
  ' "$shared/.env" 2>/dev/null) || fail 'No se pudo leer shared/.env con Node.js.'
fi

replace_link() {
  ln -sfnT -- "$1" "$2.next" && mv -Tf -- "$2.next" "$2"
}

activate() {
  mkdir -p -- "$1/tmp" || return
  # Ensure Passenger sees a different restart timestamp even within one second.
  if [[ -f $current/tmp/restart.txt && $(stat -c %Y "$current/tmp/restart.txt") == "$(date +%s)" ]]; then
    sleep 1 || return
  fi
  touch -- "$1/tmp/restart.txt" && replace_link "$1" "$current"
}

cleanup() {
  local result=$?
  if (( switching )); then
    if [[ -n $active ]]; then
      if activate "$active"; then
        echo 'Se restauró la release anterior.' >&2
      else
        echo 'No se pudo restaurar current. Revisa los enlaces antes de reintentar.' >&2
      fi
    else
      rm -f -- "$current"
    fi
  fi
  if [[ -n $staged && $(readlink -- "$current" || true) != "$staged" ]] && release_path "$staged"; then
    rm -rf -- "$staged"
  fi
  return "$result"
}
trap cleanup EXIT

check_health() {
  local release=${1##*/} attempt
  for ((attempt = 1; attempt <= health_attempts; attempt++)); do
    if curl --fail --silent --max-time 4 --include --suppress-connect-headers "$health_url" |
      node -e '
        const [release, requireDb] = process.argv.slice(1);
        let response = require("node:fs").readFileSync(0, "utf8");
        const boundary = /\r?\n\r?\n/;
        while (/^HTTP\/\S+ 1\d\d\b/.test(response)) {
          const end = boundary.exec(response);
          if (!end) process.exit(1);
          response = response.slice(end.index + end[0].length);
        }
        const end = boundary.exec(response);
        if (!end || !/^HTTP\/\S+ 200\b/.test(response)) process.exit(1);
        const headers = response.slice(0, end.index).toLowerCase().split(/\r?\n/);
        if (!headers.includes(`x-finance-release: ${release}`)) process.exit(1);
        if (requireDb === "true") {
          try {
            if (JSON.parse(response.slice(end.index + end[0].length))?.db !== "ok") process.exit(1);
          } catch {
            process.exit(1);
          }
        }
      ' "$release" "$require_db"; then
      return 0
    fi
    if (( attempt < health_attempts )); then sleep "$health_delay"; fi
  done
  return 1
}

if [[ $mode == --rollback ]]; then
  switching=1
  activate "$prior"
  check_health "$prior" || fail 'Falló la comprobación de salud del rollback.'
  replace_link "$active" "$previous"
  switching=0
  echo "Rollback completado a ${prior##*/}."
  exit 0
fi

if [[ $mode == --bootstrap ]]; then
  mode=main
  bootstrap=1
else
  bootstrap=0
fi

mkdir -p -- "$releases" "$shared/logs"
while :; do
  release=$(date -u +%Y%m%d-%H%M%S)
  release_dir="$releases/$release"
  log="$shared/logs/deploy-$release.log"
  if [[ ! -e $release_dir && ! -L $release_dir && ! -e $log && ! -L $log ]]; then break; fi
  sleep 1
done
(umask 077; set -o noclobber; : > "$log")
chmod 600 -- "$log"

redact_errors() {
  DEPLOY_DIAGNOSTIC_REMOTE="$repo_url" node -e '
    const { execFileSync } = require("node:child_process");
    const { readFileSync } = require("node:fs");
    const { parseEnv } = require("node:util");
    const [envFile, options] = process.argv.slice(1);
    const secrets = new Set();
    function addSecret(value) {
      if (!value) return;
      secrets.add(value);
      secrets.add(JSON.stringify(value).slice(1, -1));
      secrets.add(encodeURIComponent(value));
    }
    function addCredential(value) {
      addSecret(value);
      try { addSecret(decodeURIComponent(value)); } catch { /* Literal percent sign. */ }
    }
    function addUrl(value, git = false) {
      let url;
      try { url = new URL(value); } catch { return; }
      addCredential(url.password);
      if (git && /^https?:$/.test(url.protocol)) addCredential(url.username);
    }
    try {
      let errors = readFileSync(0, "utf8");
      if (!errors) process.exit(0);
      const env = parseEnv(readFileSync(envFile, "utf8"));
      for (const source of [process.env, env]) {
        addUrl(source.DATABASE_URL);
        addUrl(source.MIGRATION_DATABASE_URL);
        addUrl(source.READONLY_DATABASE_URL);
        for (const [name, value] of Object.entries(source)) {
          if (/PASSWORD|PASSWD|MYSQL_PWD/i.test(name)) addSecret(value);
        }
      }
      addUrl(process.env.DEPLOY_DIAGNOSTIC_REMOTE, true);
      if (options) {
        const defaults = execFileSync("my_print_defaults", [
          `--defaults-file=${options}`, "mysqldump", "mariadb-dump", "mysql",
          "mariadb-client", "mariadb", "client", "client-server", "client-mariadb",
        ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        for (const line of defaults.split(/\r?\n/)) {
          if (line && !line.startsWith("--")) throw new Error();
          if (/^--password[1-3]?=/.test(line)) addSecret(line.slice(line.indexOf("=") + 1));
        }
      }
      for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
        errors = errors.replaceAll(secret, "[redactado]");
      }
      process.stdout.write(errors);
    } catch {
      console.log("Diagnóstico omitido: no se pudieron filtrar las credenciales.");
    }
  ' "$shared/.env" "${options:-}"
}

run_logged() {
  local -a result
  "$@" 2>&1 1>&3 | redact_errors >> "$log"
  result=("${PIPESTATUS[@]}")
  if (( result[1] != 0 )); then echo "No se pudo guardar el diagnóstico en $log." >&2; fi
  return "${result[0]}"
} 3>&1

[[ -d $repo ]] || git init --quiet --bare "$repo"
run_logged git -C "$repo" fetch --quiet --no-tags -- "$repo_url" "$mode" ||
  fail "No se pudo descargar la ref. Revisa la URL, la ref y la deploy key. Log: $log"

mkdir -- "$release_dir"
staged=$release_dir
git -C "$repo" archive FETCH_HEAD | tar -x -C "$staged"
ln -s -- "$shared/logs" "$staged/logs"
(
  cd -- "$staged"
  npm ci --include=dev --no-audit || fail 'Falló npm ci.'
  npm run build || fail 'Falló la compilación. current no cambió.'
  npm prune --omit=dev --no-audit || fail 'Falló la poda de dependencias.'
  ln -s -- "$shared/.env" .env
  migrate=$(npm pkg get scripts.migrate)
  if [[ $migrate != '{}' ]]; then
    database=${DEPLOY_DB_NAME:-}
    options=${DEPLOY_DB_OPTIONS:-$shared/mysql.cnf}
    [[ $database =~ ^[a-zA-Z0-9_]+$ && -r $options ]] ||
      fail 'Configura DEPLOY_DB_NAME y el archivo de opciones de MariaDB antes de migrar.'
    node -e '
      const { readFileSync } = require("node:fs");
      const { parseEnv } = require("node:util");
      try {
        const env = { ...parseEnv(readFileSync(".env", "utf8")), ...process.env };
        const target = (url) => decodeURIComponent(new URL(url).pathname.slice(1));
        const name = process.argv[1];
        if (target(env.MIGRATION_DATABASE_URL) !== name ||
            (env.DATABASE_URL && target(env.DATABASE_URL) !== name)) process.exitCode = 1;
      } catch {
        process.exitCode = 1;
      }
    ' "$database" || fail 'DEPLOY_DB_NAME debe coincidir con MIGRATION_DATABASE_URL y, si existe, DATABASE_URL.'
    source "$staged/src/deploy/database.sh"
    install -d -m 700 -- "$shared/backups"
    backup=$(mktemp "$shared/backups/${staged##*/}.XXXXXX.sql")
    if ! backup_database; then
      rm -f -- "$backup"
      fail "Falló la copia de MariaDB. No se ejecutó la migración. Log: $log"
    fi
    if ! run_logged npm run migrate >/dev/null; then
      restore_database >/dev/null ||
        fail "Fallaron la migración y la restauración. Conserva la copia $backup para recuperar la BD. Log: $log"
      fail "Falló la migración. Se restauró la copia de MariaDB y current no cambió. Log: $log"
    fi
  fi
)

switching=1
activate "$staged"
if (( bootstrap )); then
  switching=0
  echo "Release ${staged##*/} preparada. Registra la aplicación y comprueba /health."
  exit 0
fi

check_health "$staged" || fail 'La release nueva no respondió a la comprobación de salud.'
if [[ -n $active ]]; then replace_link "$active" "$previous"; fi
switching=0

# Keep both rollback targets even if either is older than the five newest.
keep=1
if [[ -n $active ]]; then keep=2; fi
shopt -s nullglob
entries=("$releases/"*)
for ((i = ${#entries[@]} - 1; i >= 0; i--)); do
  entry=${entries[i]}
  if ! release_path "$entry" || [[ $entry == "$staged" || $entry == "$active" ]]; then continue; fi
  if (( keep < 5 )); then
    keep=$((keep + 1))
  else
    rm -rf -- "$entry"
  fi
done
echo "Despliegue completado en ${staged##*/}."
