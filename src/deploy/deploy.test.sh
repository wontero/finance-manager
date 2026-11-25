#!/usr/bin/env bash
set -euo pipefail

script=$(realpath "$(dirname "$0")/deploy.sh")
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT

export DEPLOY_ROOT="$fixture/app" DEPLOY_REPO_URL="$fixture/source"
export DEPLOY_NODE_BIN="$fixture/bin" DEPLOY_HEALTH_ATTEMPTS=2
export DEPLOY_HEALTH_DELAY=0 DEPLOY_HEALTH_URL=http://localhost/health
export DEPLOY_DB_NAME=finance_test EVENTS="$fixture/events"
export SCHEMA_OBJECTS="$fixture/schema-objects"
printf '%s\n' accounts v_accounts > "$SCHEMA_OBJECTS"
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
  'run build')
    if [[ ${HOLD_BUILD:-0} == 1 ]]; then
      touch "$EVENTS.building"
      for _ in {1..200}; do
        [[ ! -e $EVENTS.resume ]] || break
        sleep 0.05
      done
    fi
    [[ ${FAIL_BUILD:-0} != 1 ]] ;;
  'pkg get scripts.migrate')
    if grep -q '"migrate"' package.json; then echo '"fake"'; else echo '{}'; fi ;;
  'run migrate')
    echo migrate >> "$EVENTS"
    if [[ ${FAIL_MIGRATE:-0} == 1 ]]; then
      echo orphan >> "$SCHEMA_OBJECTS"
      echo 'migrate: error de prueba mysql://user:app%40secret@localhost/test app@secret migration@secret' >&2
      exit 1
    fi ;;
esac
EOF
cat > "$DEPLOY_NODE_BIN/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo health >> "$EVENTS"
[[ ${FAIL_HEALTH:-0} != 1 ]] || exit 22
release=$(basename "$(readlink "$DEPLOY_ROOT/current")")
body=${HEALTH_BODY:-'{"db":"ok"}'}
printf 'HTTP/1.1 200 OK\r\nX-Finance-Release: %s\r\n\r\n%s' \
  "${REPORTED_RELEASE:-$release}" "$body"
EOF
cat > "$DEPLOY_NODE_BIN/mysqldump" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ $1 == --defaults-file="$DEPLOY_ROOT/shared/mysql.cnf" ]]
[[ $2 == --single-transaction && $3 == finance_test && $# == 3 ]]
echo backup >> "$EVENTS"
if [[ ${FAIL_DUMP:-0} == 1 ]]; then
  echo 'mysqldump: error de prueba backup-secret' >&2
  exit 1
fi
printf 'CREATE TABLE `accounts` (id INT);\nCREATE VIEW `v_accounts` AS SELECT id FROM `accounts`;\n'
EOF
cat > "$DEPLOY_NODE_BIN/mysql" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ $1 == --defaults-file="$DEPLOY_ROOT/shared/mysql.cnf" ]]
[[ $2 == --database=finance_test ]]
if [[ $# -gt 2 ]]; then
  [[ $3 == --batch && $4 == --skip-column-names && $5 == --raw && $6 == --execute=* ]]
  [[ $6 == *information_schema.tables* && $6 == *'DATABASE()'* ]]
  echo inspect >> "$EVENTS"
  while IFS= read -r name; do
    case $name in
      v_*) printf 'DROP VIEW `%s`;\n' "$name" ;;
      *) printf 'DROP TABLE `%s`;\n' "$name" ;;
    esac
  done < "$SCHEMA_OBJECTS"
  exit 0
fi
echo restore >> "$EVENTS"
if [[ ${FAIL_RESTORE:-0} == 1 ]]; then
  echo 'mysql: error de restauración de prueba backup-secret' >&2
  exit 1
fi
[[ $(cat) == $'SET FOREIGN_KEY_CHECKS=0;\nDROP TABLE `accounts`;\nDROP VIEW `v_accounts`;\nDROP TABLE `orphan`;\nSET FOREIGN_KEY_CHECKS=1;\nCREATE TABLE `accounts` (id INT);\nCREATE VIEW `v_accounts` AS SELECT id FROM `accounts`;' ]]
printf '%s\n' accounts v_accounts > "$SCHEMA_OBJECTS"
EOF
cat > "$DEPLOY_NODE_BIN/my_print_defaults" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ $1 == --defaults-file="$DEPLOY_ROOT/shared/mysql.cnf" ]]
echo --password=backup-secret
EOF
chmod +x "$DEPLOY_NODE_BIN/"*

deploy() { bash "$script" "$@"; }
current() { readlink "$DEPLOY_ROOT/current"; }
fail() { echo "FALLA $*" >&2; exit 1; }

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

deploy --rollback --yes
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
[[ $(cat "$EVENTS") == $'backup\nmigrate\ninspect\nrestore' ]] || fail 'f: orden de copia, migración y restauración'
[[ $(cat "$SCHEMA_OBJECTS") == $'accounts\nv_accounts' ]] || fail 'f: la restauración dejó objetos ajenos al volcado'
if grep -Eqi '(DROP|CREATE) DATABASE' "$DEPLOY_ROOT"/shared/backups/*.sql; then
  fail 'f: el volcado modifica la base'
fi
: > "$EVENTS"
deploy
[[ $(current) != "$active" ]] || fail 'f: no se activó la migración correcta'
[[ $(cat "$EVENTS") == $'backup\nmigrate\nhealth' ]] || fail 'f: orden de copia, migración y salud'
echo 'PASA S9f'

active=$(current)
prior=$(readlink "$DEPLOY_ROOT/shared/previous")
if deploy --rollback </dev/null; then fail 'S13: se aceptó rollback sin TTY'; fi
if printf 'N\n' | script -qec "bash '$script' --rollback" /dev/null; then
  fail 'S13: se aceptó rechazo interactivo'
fi
[[ $(current) == "$active" ]] || fail 'S13: current cambió sin confirmación'
output=$(deploy --rollback --yes 2>&1)
[[ $output == *"de ${active##*/} a ${prior##*/}"* ]] || fail 'S13: falta origen o destino'
[[ $(current) == "$prior" ]] || fail 'S13: no se activó previous'
deploy --rollback --yes
[[ $(current) == "$active" ]] || fail 'S13: doble rollback no volvió a la release original'
echo 'PASA S13'

log_from_error() {
  [[ $1 =~ (shared/logs/deploy-[0-9]{8}-[0-9]{6}\.log) ]] || fail "S14: falta la ruta del log: $1"
  echo "$DEPLOY_ROOT/${BASH_REMATCH[1]}"
}
: > "$EVENTS"
if output=$(FAIL_DUMP=1 deploy 2>&1); then fail 'S14: se aceptó una copia fallida'; fi
[[ $(current) == "$active" && $(cat "$EVENTS") == backup ]] || fail 'S14: cambió current o se llamó a migrate'
log=$(log_from_error "$output")
[[ -f $log && $(stat -c '%a' "$log") == 600 ]] || fail 'S14: log ausente o permisos incorrectos'
grep -Fq 'mysqldump: error de prueba' "$log" || fail 'S14: error de mysqldump ausente'
if grep -Fq 'backup-secret' "$log"; then fail 'S14: contraseña en el log'; fi

printf '%s\n' 'export DATABASE_URL = "mysql://user:app%40secret@localhost/test"' \
  'MIGRATION_DATABASE_URL=mysql://migration:migration%40secret@localhost/test' > "$DEPLOY_ROOT/shared/.env"
if output=$(FAIL_MIGRATE=1 FAIL_RESTORE=1 deploy 2>&1); then fail 'S14: se aceptó una restauración fallida'; fi
log=$(log_from_error "$output")
grep -Fq 'migrate: error de prueba' "$log" && grep -Fq 'mysql: error de restauración de prueba' "$log" ||
  fail 'S14: error de migración o restauración ausente'
if grep -Eq 'app%40secret|app@secret|migration@secret|backup-secret' "$log"; then fail 'S14: contraseña en el log'; fi
if output=$(deploy ref-inexistente 2>&1); then fail 'S14: se aceptó una ref inexistente'; fi
log=$(log_from_error "$output")
grep -Fq 'ref-inexistente' "$log" || fail 'S14: error de git fetch ausente'
echo 'PASA S14'

if HEALTH_BODY='{ "db": "unavailable" }' deploy; then fail 'S15: se aceptó db no disponible'; fi
[[ $(current) == "$active" ]] || fail 'S15: no se restauró current tras fallar la BD'
if HEALTH_BODY='respuesta inválida "db":"ok"' deploy; then fail 'S15: se aceptó un cuerpo que no es JSON'; fi
if HEALTH_BODY='{ "db": "unavailable" }' deploy --rollback --yes; then fail 'S15: rollback aceptó db no disponible'; fi
[[ $(current) == "$active" && $(readlink "$DEPLOY_ROOT/shared/previous") == "$prior" ]] ||
  fail 'S15: rollback fallido cambió los enlaces'
HEALTH_BODY='{ "db": "ok" }' deploy
active=$(current)
: > "$DEPLOY_ROOT/shared/.env"
HEALTH_BODY='{ "db": "not_configured" }' deploy
[[ $(current) != "$active" ]] || fail 'S15: sin BD no se activó la release'
rm -- "$DEPLOY_ROOT/shared/.env"
HEALTH_BODY='{ "db": "not_configured" }' deploy --rollback --yes
[[ $(current) == "$active" ]] || fail 'S15: sin .env no se activó previous'
touch "$DEPLOY_ROOT/shared/.env"
echo 'PASA S15'

snapshot() {
  find "$DEPLOY_ROOT" -printf '%P %y %T@ %l\n' | sort
}
before=$(snapshot)
if output=$(deploy --bootstrap 2>&1); then fail 'S17: bootstrap aceptó una release activa'; fi
[[ $output == *'ya tiene una release activa'* && $(snapshot) == "$before" ]] || fail 'S17: bootstrap modificó el árbol'
rm -- "$DEPLOY_ROOT/.deploy.lock"
before=$(snapshot)
if output=$(deploy --bootstrap 2>&1); then fail 'S17: bootstrap aceptó una release activa sin lock'; fi
[[ $output == *'ya tiene una release activa'* && $(snapshot) == "$before" ]] || fail 'S17: bootstrap creó un lock'

HOLD_BUILD=1 FAIL_BUILD=1 deploy &
running=$!
for _ in {1..200}; do
  [[ ! -e $EVENTS.building ]] || break
  sleep 0.05
done
[[ -e $EVENTS.building ]] || fail 'S17: el primer despliegue no llegó al build'
touch -t 202611240000 "$DEPLOY_ROOT/.deploy.lock"
before=$(snapshot)
second_status=0
output=$(deploy 2>&1) || second_status=$?
after=$(snapshot)
touch "$EVENTS.resume"
if wait "$running"; then fail 'S17: el primer despliegue debía fallar en build'; fi
[[ $second_status != 0 && $output == *'Ya hay un despliegue en curso'* ]] || fail 'S17: faltó el bloqueo concurrente'
[[ $after == "$before" ]] || fail 'S17: el segundo despliegue modificó el árbol'
echo 'PASA S17'
