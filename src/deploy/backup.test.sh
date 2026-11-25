#!/usr/bin/env bash
set -euo pipefail

script=$(realpath "$(dirname "$0")/backup.sh")
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT
umask 077
export DEPLOY_ROOT="$fixture/app" DEPLOY_DB_NAME=finance_test
export DEPLOY_NODE_BIN="$fixture/bin" TMPDIR="$fixture/tmp"
export EVENTS="$fixture/events" PROCESSES="$fixture/processes" REMOTE="$fixture/remote"
export BACKUP_RCLONE_REMOTE=fixture:daily
export REAL_DATE=$(command -v date) REAL_GZIP=$(command -v gzip) REAL_FLOCK=$(command -v flock)
shared="$DEPLOY_ROOT/shared"
daily="$shared/backups/daily"
mkdir -p "$DEPLOY_NODE_BIN" "$TMPDIR" "$shared" "$daily" "$REMOTE"
export PATH="$DEPLOY_NODE_BIN:$PATH"
printf 'test-%s-%s\n' "$RANDOM" "$RANDOM" > "$shared/backup.passphrase"
touch "$shared"/{.env,mysql.cnf} "$EVENTS" "$PROCESSES"

cat > "$DEPLOY_NODE_BIN/double" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
tool=${0##*/}
printf '%s %q\n' "$tool" "$*" >> "$PROCESSES"
if env | grep -F -f "$DEPLOY_ROOT/shared/backup.passphrase" >/dev/null; then
  echo passphrase-in-environment >> "$PROCESSES"
fi
case $tool in
  date)
    case $1 in
      +%*) exec "$REAL_DATE" -d '2026-11-25 03:30:00' "$@" ;;
      *) exec "$REAL_DATE" "$@" ;;
    esac ;;
  mysql)
    if [[ $* == *@@log_bin* ]]; then
      echo preflight >> "$EVENTS"
      printf '%s\t0\t1\t0\t0\n' "${BLOCK_RESTORE:-0}"
    elif [[ $* == *information_schema.tables* ]]; then
      echo inspect >> "$EVENTS"
    else
      cat > "$EVENTS.sql"
      echo import >> "$EVENTS"
    fi ;;
  mysqldump)
    if [[ $* == *--skip-triggers* ]]; then
      echo dump >> "$EVENTS"
      echo 'CREATE TABLE fixture (id INT);'
      [[ ${FAIL_STAGE:-} != dump ]]
    else
      echo triggers >> "$EVENTS"
      [[ ${FAIL_STAGE:-} != triggers ]]
      if [[ ${FAIL_STAGE:-} == no-triggers ]]; then exit 0; fi
      echo '/*!50003 CREATE*/ /*!50003 TRIGGER fixture_tr BEFORE INSERT ON fixture FOR EACH ROW SET NEW.id = 1 */;;'
    fi ;;
  gzip)
    if [[ ${FAIL_STAGE:-} == gzip && $1 == -c ]]; then
      "$REAL_GZIP" "$@"
      exit 1
    fi
    exec "$REAL_GZIP" "$@" ;;
  gpg)
    [[ $* == *--batch* && $* == *--pinentry-mode\ loopback* && $* == *--passphrase-file* ]]
    if [[ $* == *--symmetric* ]]; then
      [[ $* == *--cipher-algo\ AES256* ]]
      printf 'ENC\n'
      cat
      if [[ ${FAIL_STAGE:-} == gpg ]]; then
        cat "$DEPLOY_ROOT/shared/backup.passphrase" >&2
        exit 1
      fi
    else
      [[ $* == *--decrypt* ]]
      if [[ ${CHECK_RESTORE_TEMP:-0} == 1 ]]; then
        backups="$DEPLOY_ROOT/shared/backups"
        shopt -s nullglob
        temps=("$backups"/finance-restore.*)
        [[ ${#temps[@]} == 1 && -f ${temps[0]} && ! -L ${temps[0]} &&
           ! -e $backups/finance-restore.interrumpido.sql &&
           $(stat -c %a "$backups") == 700 && $(stat -c %a "${temps[0]}") == 600 ]]
      fi
      { read -r header; [[ $header == ENC && ${BAD_PHRASE:-0} == 0 ]] && cat; } < "${!#}"
    fi ;;
  my_print_defaults) ;;
  rclone)
    echo "rclone $*" >> "$EVENTS"
    case $1 in
      copy)
        [[ $3 == fixture:daily && ${FAIL_STAGE:-} != rclone ]] && cp -- "$2" "$REMOTE" ;;
      lsf)
        [[ $* == *--files-only* && ${FAIL_STAGE:-} != lsf ]] &&
          find "$REMOTE" -maxdepth 1 -type f -printf '%f\n' ;;
      deletefile)
        [[ $2 == fixture:daily/* ]] && rm -- "$REMOTE/${2#fixture:daily/}" ;;
      *) exit 10 ;;
    esac ;;
  flock)
    [[ $1 == -w && $2 == 600 && $3 == 9 ]] || exit 2
    if [[ ${FORCE_TIMEOUT:-0} == 1 ]]; then exec "$REAL_FLOCK" -n "$3"; fi
    exec "$REAL_FLOCK" "$@" ;;
esac
EOF
chmod +x "$DEPLOY_NODE_BIN/double"
for name in date mysql mysqldump gzip gpg my_print_defaults rclone flock; do
  ln -s double "$DEPLOY_NODE_BIN/$name"
done

backup() { bash "$script" "$@"; }
fail() { printf 'FALLA %s\n' "$*" >&2; exit 1; }
no_plaintext() {
  [[ -z $(find "$DEPLOY_ROOT" "$TMPDIR" -type f \( -name '*.sql' -o -name '*.gz' -o -name '*.tmp' \) -print) ]] &&
    [[ -z $(find "$TMPDIR" -mindepth 1 -print) ]]
}
shopt -s nullglob
for stage in dump triggers no-triggers gzip gpg; do
  : > "$EVENTS"
  if FAIL_STAGE=$stage backup run >"$fixture/out" 2>&1; then fail "S1: aceptó fallo de $stage"; fi
  no_plaintext || fail "S1: fichero en claro tras fallo de $stage"
  files=("$daily"/*)
  [[ ${#files[@]} == 0 ]] || fail "S1: fichero parcial tras fallo de $stage"
  if grep -q '^rclone ' "$EVENTS"; then fail 'S4: se llamó a rclone tras un fallo del volcado'; fi
done
output=$(backup run)
file="$daily/finanzas-20261125-033000.sql.gz.gpg"
files=("$daily"/*)
[[ -z $output && ${#files[@]} == 1 && -s $file && $(stat -c '%a' "$file") == 600 ]] ||
  fail 'S1: se esperaba una única copia privada y una ejecución silenciosa'
no_plaintext || fail 'S1: quedó un fichero en claro'
if grep -RFq -f "$shared/backup.passphrase" -- "$PROCESSES" "$shared/logs" "$fixture/out"; then
  fail 'S2: la frase apareció en argv, entorno o diagnóstico'
fi
! grep -qx passphrase-in-environment "$PROCESSES" || fail 'S2: la frase apareció en el entorno'
grep -Fxq '[redactado]' "$shared/logs/backup-20261125.log" || fail 'S2: faltó el diagnóstico redactado'
echo 'PASA M-007 S1–S2'

: > "$EVENTS"
backup verify "$file"
backup list | grep -Fxq "${file##*/}"
[[ ! -s $EVENTS ]] || fail 'S5: verify o list tocaron la base o el remoto'
printf 'archivo corrupto\n' > "$fixture/corrupt.gpg"
printf 'ENC\n' > "$fixture/incomplete.gpg"
printf 'CREATE TABLE foo (id INT);\n' | "$REAL_GZIP" >> "$fixture/incomplete.gpg"
if backup restore "$fixture/corrupt.gpg" --yes ||
   BAD_PHRASE=1 backup restore "$file" --yes ||
   backup restore "$fixture/incomplete.gpg" --yes ||
   printf 'otra_base\n' | backup restore "$file"; then
  fail 'S5: se aceptó un archivo inválido o faltó la confirmación'
fi
[[ ! -s $EVENTS ]] || fail 'S5: se tocó la base antes de validar'
if BLOCK_RESTORE=1 backup restore "$file" --yes; then fail 'S5: se aceptó prechequeo fallido'; fi
[[ $(cat "$EVENTS") == preflight ]] || fail 'S5: se importó tras el prechequeo fallido'
: > "$EVENTS"
printf 'finance_test\n' | backup restore "$file"
[[ $(cat "$EVENTS") == $'preflight\ninspect\nimport' ]] && grep -q 'TRIGGER fixture_tr' "$EVENTS.sql" ||
  fail 'S5: faltó importar a través de restore_database'
no_plaintext || fail 'S5: quedó el volcado temporal tras restaurar'
echo 'PASA M-007 S5'

backups="$shared/backups"
chmod 755 "$backups"
touch "$backups/finance-restore.interrumpido.sql"
CHECK_RESTORE_TEMP=1 backup restore "$file" --yes || fail 'M-007B S12: ubicación, permisos o limpieza previa del temporal'
temps=("$backups"/finance-restore.*)
[[ ${#temps[@]} == 0 ]] && no_plaintext || fail 'M-007B S12: quedó un volcado en claro'
echo 'PASA M-007B S12'

mkfifo "$fixture/answer"
exec 8<>"$fixture/answer"
: > "$fixture/prompt"
timeout 10 bash "$script" restore "$file" <&8 >"$fixture/prompt" 2>&1 &
restore_pid=$!
for _ in {1..200}; do
  if grep -q 'Escribe finance_test' "$fixture/prompt"; then break; fi
  sleep 0.02
done
grep -q 'Escribe finance_test' "$fixture/prompt" || fail 'M-007B S13: no pidió confirmación'
"$REAL_FLOCK" -n "$DEPLOY_ROOT/.deploy.lock" true || fail 'M-007B S13: restore tomó el lock antes de confirmar'
printf 'finance_test\n' >&8
wait "$restore_pid" || fail 'M-007B S13: restore no completó tras confirmar'
exec 8>&-
echo 'PASA M-007B S13 restore'

touch -d '25 hours ago' "$daily/.finanzas-old" "$daily/manual"
touch "$daily/.finanzas-recent"
ln -s "$daily/manual" "$daily/.finanzas-link"
touch -h -d '25 hours ago' "$daily/.finanzas-link"
if FAIL_STAGE=dump backup run >"$fixture/out" 2>&1; then fail 'M-007B S14: aceptó fallo de volcado'; fi
[[ ! -e $daily/.finanzas-old && -f $daily/.finanzas-recent &&
   -L $daily/.finanzas-link && -f $daily/manual ]] ||
  fail 'M-007B S14: limpieza incorrecta de temporales'
rm -- "$daily/.finanzas-recent" "$daily/.finanzas-link" "$daily/manual"
echo 'PASA M-007B S14'

seed() {
  for (( i = 1; i < 400; i++ )); do
    name="finanzas-$("$REAL_DATE" -d "2026-11-25 - $i days" +%Y%m%d)-033000.sql.gz.gpg"
    touch "$daily/$name" "$REMOTE/$name"
  done
  touch "$daily/manual.sql.gz.gpg" "$REMOTE/manual.sql.gz.gpg"
}
expected_copies() {
  for (( i = 0; i < 30; i++ )); do
    "$REAL_DATE" -d "2026-11-25 - $i days" +finanzas-%Y%m%d-033000.sql.gz.gpg
  done
  for (( i = 0; i < 12; i++ )); do
    "$REAL_DATE" -d "2026-11-01 - $i months" +finanzas-%Y%m%d-033000.sql.gz.gpg
  done
  echo manual.sql.gz.gpg
}
names() { find "$1" -maxdepth 1 -type f -printf '%f\n' | sort; }
rm -- "$file"
seed
: > "$EVENTS"
backup run
expected=$(expected_copies | sort -u)
[[ $(names "$daily") == "$expected" && $(names "$REMOTE") == "$expected" ]] ||
  fail 'S3: retención local o remota incorrecta'
! grep -Eq '^rclone (sync|purge) ' "$EVENTS" || fail 'S3: borrado masivo'
echo 'PASA M-007 S3'

rm -- "$file"
seed
remote_before=$(names "$REMOTE")
local_before=$(names "$daily")
: > "$EVENTS"
if FAIL_STAGE=dump backup run >"$fixture/out" 2>&1; then fail 'S4: aceptó fallo de volcado'; fi
[[ $(names "$daily") == "$local_before" && $(names "$REMOTE") == "$remote_before" ]] &&
  ! grep -q '^rclone ' "$EVENTS" || fail 'S4: subió o borró copias tras fallar el volcado'
if FAIL_STAGE=rclone backup run >"$fixture/out" 2>&1; then fail 'S4: aceptó fallo de subida'; fi
[[ -s $file && $(names "$daily") == "$expected" && $(names "$REMOTE") == "$remote_before" ]] &&
  grep -Eqi 'rclone|subir' "$fixture/out" || fail 'S4: no conservó la copia o faltó el diagnóstico'
echo 'PASA M-007 S4'

(
  exec 9<>"$DEPLOY_ROOT/.deploy.lock"
  "$REAL_FLOCK" -n 9
  : > "$EVENTS"
  if FORCE_TIMEOUT=1 backup run >"$fixture/out" 2>&1; then fail 'S7: se ignoró el lock compartido'; fi
  [[ ! -s $EVENTS ]] && grep -q '10 minutos' "$fixture/out" ||
    fail 'S7: faltó el diagnóstico o el backup se solapó'
)
echo 'PASA M-007 S7'
