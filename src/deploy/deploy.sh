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
staged=
switching=0

[[ $# -le 1 ]] || fail 'Uso: deploy.sh [ref | --bootstrap | --rollback]'
mode=${1:-main}
case "$mode" in
  --bootstrap|--rollback) ;;
  -*) fail 'Uso: deploy.sh [ref | --bootstrap | --rollback]' ;;
esac
[[ $health_attempts =~ ^[1-9][0-9]*$ && $health_delay =~ ^(0|[1-9][0-9]*)$ ]] ||
  fail 'Configura DEPLOY_HEALTH_ATTEMPTS (>0) y DEPLOY_HEALTH_DELAY (>=0) como enteros.'

mkdir -p -- "$root" "$releases" "$shared"
exec 9>"$root/.deploy.lock"
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
  local release=${1##*/} headers attempt
  for ((attempt = 1; attempt <= health_attempts; attempt++)); do
    if headers=$(curl --fail --silent --max-time 4 --dump-header - --output /dev/null --write-out '%{http_code}' "$health_url" | tr -d '\r') &&
      [[ $headers == *$'\n200' ]] && grep -Fxiq "X-Finance-Release: $release" <<< "$headers"; then
      return 0
    fi
    if (( attempt < health_attempts )); then sleep "$health_delay"; fi
  done
  return 1
}

if [[ $mode == --rollback ]]; then
  [[ -n $active && -n $prior && $active != "$prior" ]] || fail 'No hay una release anterior para restaurar.'
  switching=1
  activate "$prior"
  check_health "$prior" || fail 'Falló la comprobación de salud del rollback.'
  replace_link "$active" "$previous"
  switching=0
  echo "Rollback completado a ${prior##*/}."
  exit 0
fi

if [[ $mode == --bootstrap ]]; then
  [[ -z $active ]] || fail 'La aplicación ya tiene una release activa.'
  mode=main
  bootstrap=1
else
  bootstrap=0
fi

[[ -r $shared/.env ]] || fail 'Prepara shared/.env antes de desplegar.'
[[ -d $repo ]] || git init --quiet --bare "$repo"
git -C "$repo" fetch --quiet --no-tags -- "$repo_url" "$mode" 2>/dev/null ||
  fail 'No se pudo descargar la ref. Revisa la URL, la ref y la deploy key.'

while :; do
  release_dir="$releases/$(date -u +%Y%m%d-%H%M%S)"
  if [[ ! -e $release_dir && ! -L $release_dir ]]; then break; fi
  sleep 1
done
mkdir -- "$release_dir"
staged=$release_dir
git -C "$repo" archive FETCH_HEAD | tar -x -C "$staged"
mkdir -p -- "$shared/logs"
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
    install -d -m 700 -- "$shared/backups"
    backup=$(mktemp "$shared/backups/${staged##*/}.XXXXXX.sql")
    if ! mysqldump --defaults-file="$options" --single-transaction --add-drop-database --databases "$database" > "$backup" 2>/dev/null; then
      rm -f -- "$backup"
      fail 'Falló la copia de MariaDB. No se ejecutó la migración.'
    fi
    if ! npm run migrate >/dev/null 2>&1; then
      mysql --defaults-file="$options" < "$backup" >/dev/null 2>&1 ||
        fail "Fallaron la migración y la restauración. Conserva la copia $backup para recuperar la BD."
      fail 'Falló la migración. Se restauró la copia de MariaDB y current no cambió.'
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
