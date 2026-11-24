#!/usr/bin/env bash
set -euo pipefail

script=$(realpath "$(dirname "$0")/deploy.sh")
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT

export DEPLOY_ROOT="$fixture/app" DEPLOY_REPO_URL="$fixture/source"
export DEPLOY_NODE_BIN="$fixture/bin" DEPLOY_HEALTH_ATTEMPTS=2
export DEPLOY_HEALTH_DELAY=0 DEPLOY_HEALTH_URL=http://localhost/health
export DEPLOY_DB_NAME=finance_test EVENTS="$fixture/events"
mkdir -p "$DEPLOY_NODE_BIN" "$DEPLOY_ROOT/shared"
touch "$DEPLOY_ROOT/shared/.env" "$EVENTS"
install -m 600 /dev/null "$DEPLOY_ROOT/shared/mysql.cnf"

git init -q -b main "$DEPLOY_REPO_URL"
commit() {
  git -C "$DEPLOY_REPO_URL" add package.json
  git -C "$DEPLOY_REPO_URL" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm "$1"
}
echo '{}' > "$DEPLOY_REPO_URL/package.json"
commit bootstrap

cat > "$DEPLOY_NODE_BIN/npm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  'run build') [[ ${FAIL_BUILD:-0} != 1 ]] ;;
  'pkg get scripts.migrate')
    if grep -q '"migrate"' package.json; then echo '"fake"'; else echo '{}'; fi ;;
  'run migrate') echo migrate >> "$EVENTS"; [[ ${FAIL_MIGRATE:-0} != 1 ]] ;;
esac
EOF
cat > "$DEPLOY_NODE_BIN/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo health >> "$EVENTS"
[[ ${FAIL_HEALTH:-0} != 1 ]] || exit 22
release=$(basename "$(readlink "$DEPLOY_ROOT/current")")
printf 'HTTP/1.1 200 OK\r\nX-Finance-Release: %s\r\n\r\n200' "${REPORTED_RELEASE:-$release}"
EOF
cat > "$DEPLOY_NODE_BIN/mysqldump" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ $1 == --defaults-file="$DEPLOY_ROOT/shared/mysql.cnf" ]]
[[ $2 == --single-transaction && $3 == --add-drop-database && $4 == --databases && $5 == finance_test ]]
echo backup >> "$EVENTS"
echo 'DROP DATABASE finance_test;'
EOF
cat > "$DEPLOY_NODE_BIN/mysql" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ $1 == --defaults-file="$DEPLOY_ROOT/shared/mysql.cnf" ]]
grep -qx 'DROP DATABASE finance_test;'
echo restore >> "$EVENTS"
EOF
chmod +x "$DEPLOY_NODE_BIN/"*

deploy() { bash "$script" "$@"; }
current() { readlink "$DEPLOY_ROOT/current"; }
fail() { echo "FALLA S9: $*" >&2; exit 1; }

# The first release has no target to restore on failure.
if FAIL_HEALTH=1 deploy; then fail 'salud inicial aceptada'; fi
[[ ! -e "$DEPLOY_ROOT/current" && ! -L "$DEPLOY_ROOT/current" ]] || fail 'current inicial quedó enlazado'
: > "$EVENTS"
deploy --bootstrap
[[ ! -s "$EVENTS" ]] || fail 'bootstrap consultó la URL antes de registrar la app'
first=$(current)
[[ -d "$first" && -f "$first/tmp/restart.txt" ]] || fail 'a: no se activó la release'
[[ $(readlink "$first/.env") == "$DEPLOY_ROOT/shared/.env" ]] || fail 'a: falta enlace a .env'
deploy
second=$(current)
[[ $first != "$second" && -f "$second/tmp/restart.txt" ]] || fail 'a: despliegue normal'
[[ $(cat "$EVENTS") == health ]] || fail 'a: no se comprobó la salud'
echo 'PASA S9a'

if FAIL_BUILD=1 deploy; then fail 'b: se aceptó el build fallido'; fi
[[ $(current) == "$second" ]] || fail 'b: current cambió'
echo 'PASA S9b'

if REPORTED_RELEASE=${second##*/} deploy; then fail 'c: se aceptó la respuesta de la release anterior'; fi
[[ $(current) == "$second" ]] || fail 'c: no se restauró current'
echo 'PASA S9c'

deploy --rollback
[[ $(current) == "$first" ]] || fail 'd: current no apunta a la anterior'
echo 'PASA S9d'

for _ in {1..7}; do deploy; done
shopt -s nullglob
releases=("$DEPLOY_ROOT/releases/"*)
[[ ${#releases[@]} == 5 ]] || fail 'e: no quedan cinco releases'
echo 'PASA S9e'

active=$(current)
echo '{"scripts":{"migrate":"fake"}}' > "$DEPLOY_REPO_URL/package.json"
commit migration
: > "$EVENTS"
if FAIL_MIGRATE=1 deploy; then fail 'f: se aceptó la migración fallida'; fi
[[ $(current) == "$active" ]] || fail 'f: current cambió'
[[ $(cat "$EVENTS") == $'backup\nmigrate\nrestore' ]] || fail 'f: orden de copia, migración y restauración'
: > "$EVENTS"
deploy
[[ $(current) != "$active" ]] || fail 'f: no se activó la migración correcta'
[[ $(cat "$EVENTS") == $'backup\nmigrate\nhealth' ]] || fail 'f: orden de copia, migración y salud'
echo 'PASA S9f'
