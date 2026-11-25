#!/usr/bin/env bash
set -euo pipefail
umask 077
export LC_ALL=C TZ=America/La_Paz
export PATH="${DEPLOY_NODE_BIN:-/opt/cpanel/ea-nodejs22/bin}:$HOME/bin:$PATH"

script_dir=$(dirname -- "$(realpath -- "${BASH_SOURCE[0]}")")
source "$script_dir/deploy.sh"
source "$script_dir/database.sh"

usage='Uso: backup.sh run | list | verify <archivo> | restore <archivo> [--yes]'
case "${1:-}:$#" in
  run:1|list:1|verify:2|restore:2) ;;
  restore:3) [[ $3 == --yes ]] || fail "$usage" ;;
  *) fail "$usage" ;;
esac

root=$(realpath -m -- "${DEPLOY_ROOT:-$HOME/apps/finanzasmateo}")
shared=$(realpath -m -- "${DEPLOY_SHARED_DIR:-$root/shared}")
daily="$shared/backups/daily"
lock="$root/.deploy.lock"
repo_url=
archive_pattern='^finanzas-[0-9]{8}-[0-9]{6}\.sql\.gz\.gpg$'

local_archives() {
  local file
  for file in "$daily"/finanzas-*.sql.gz.gpg; do
    if [[ -f $file && ! -L $file && ${file##*/} =~ $archive_pattern ]]; then
      printf '%s\n' "${file##*/}"
    fi
  done
}

if [[ $1 == list ]]; then
  local_archives
  exit 0
fi

passphrase_file="$shared/backup.passphrase"
[[ -f $passphrase_file && ! -L $passphrase_file && -s $passphrase_file &&
   $(stat -c %a -- "$passphrase_file") == 600 ]] ||
  fail 'Prepara shared/backup.passphrase como archivo privado con permisos 600.'
gpg_options=(--no-options --batch --no-tty --pinentry-mode loopback --no-symkey-cache
  --passphrase-file "$passphrase_file" --output -)

if [[ $1 != run ]]; then
  input=$(realpath -- "$2") || fail 'No se encontró el archivo de copia.'
  [[ -f $input && -r $input ]] || fail 'No se pudo leer el archivo de copia.'
fi

options=
if [[ $1 != verify ]]; then
  database=${DEPLOY_DB_NAME:-}
  options=${DEPLOY_DB_OPTIONS:-$shared/mysql.cnf}
  [[ $database =~ ^[a-zA-Z0-9_]+$ && -f $options && -r $options ]] ||
    fail 'Configura DEPLOY_DB_NAME y el archivo de opciones de MariaDB.'
  options=$(realpath -s -- "$options")
  mkdir -p -- "$root"
  wait_for_deploy_lock
fi

timestamp=$(date +%Y%m%d-%H%M%S)
day=${timestamp:0:8}
install -d -m 700 -- "$shared/logs"
log="$shared/logs/backup-$day.log"
[[ ! -L $log ]] || fail 'El log de copias debe ser un archivo local.'
touch -- "$log"
chmod 600 -- "$log"

temporary=
cleanup_backup() {
  if [[ -n $temporary ]]; then rm -f -- "$temporary"; fi
}
trap cleanup_backup EXIT
trap 'exit 1' HUP INT TERM

backup_error() {
  printf '%s\n' "$1" >> "$log"
  printf '%s Log: %s\n' "$1" "$log" >&2
}

unpack() {
  run_logged gpg "${gpg_options[@]}" --decrypt -- "$input" | run_logged gzip -dc
}

verify_dump() {
  local emit=$1
  shift
  awk -v emit="$emit" '
    emit { print }
    { sub(/\r$/, "") }
    $0 == "-- FinanceManager: triggers" { section = 1 }
    section && /^(CREATE|\/\*![0-9]+ CREATE).* TRIGGER[[:space:]]/ { trigger = 1 }
    END { exit !(trigger && $0 == "-- FinanceManager: fin de triggers") }
  ' "$@"
}

case "$1" in
  verify)
    if ! unpack | verify_dump 0; then
      backup_error 'No se pudo verificar la copia. Comprueba la frase, el archivo y la sección de triggers.'
      exit 1
    fi
    echo 'Copia verificada.'
    exit 0 ;;
  restore)
    if [[ ${3:-} != --yes ]]; then
      printf 'Escribe %s para confirmar que se reemplazarán sus objetos: ' "$database" >&2
      IFS= read -r answer && [[ $answer == "$database" ]] || fail 'Restauración cancelada.'
    fi
    temporary=$(mktemp "${TMPDIR:-/tmp}/finance-restore.XXXXXX.sql")
    if ! unpack > "$temporary" || ! verify_dump 0 "$temporary"; then
      backup_error 'No se pudo verificar la copia antes de restaurar. Comprueba la frase, el archivo y la sección de triggers.'
      exit 1
    fi
    backup=$temporary
    if ! restore_database >/dev/null; then
      backup_error 'Falló la restauración de MariaDB. Revisa el prechequeo y el estado de la base.'
      exit 1
    fi
    echo "Copia restaurada en $database."
    exit 0 ;;
esac

remote=${BACKUP_RCLONE_REMOTE:-}
[[ -z $remote || $remote =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]*: ]] ||
  fail 'Configura BACKUP_RCLONE_REMOTE con un remoto de rclone nombrado.'

install -d -m 700 -- "$daily"
file="$daily/finanzas-$timestamp.sql.gz.gpg"
temporary=$(mktemp "$daily/.finanzas-$timestamp.XXXXXX")
if ! { backup= backup_database && printf '%s\n' '-- FinanceManager: fin de triggers'; } |
  verify_dump 1 |
  run_logged gzip -c |
  run_logged gpg "${gpg_options[@]}" --symmetric --cipher-algo AES256 --compress-algo none > "$temporary"; then
  backup_error 'Falló el volcado, la comprobación de triggers, la compresión o el cifrado. Se canceló la copia.'
  exit 1
fi
ln -T -- "$temporary" "$file" || fail 'No se pudo publicar la copia sin sobrescribir un archivo existente.'
rm -- "$temporary"
temporary=

# Keep the newest file per day and the first available file in each of 12 calendar months.
month=${day:0:6}
first_month=$(date -d "${day:0:4}-${day:4:2}-01 - 11 months" +%Y%m)
expired_archives() {
  local name
  while IFS= read -r name; do
    if [[ $name =~ $archive_pattern ]]; then printf '%s\n' "$name"; fi
  done | sort -u | awk -v first="$first_month" -v last="$month" '
    {
      files[++count] = $0
      day = substr($0, 10, 8)
      month = substr(day, 1, 6)
      if (month >= first && month <= last && !(month in monthly)) {
        monthly[month] = $0
        keep[$0] = 1
      }
    }
    END {
      for (i = count; i > 0 && days < 30; i--) {
        day = substr(files[i], 10, 8)
        if (!(day in daily)) {
          daily[day] = 1
          keep[files[i]] = 1
          days++
        }
      }
      for (i = 1; i <= count; i++) if (!(files[i] in keep)) print files[i]
    }
  '
}

status=0
if [[ -n $remote ]] && ! run_logged rclone copy "$file" "$remote" >/dev/null; then
  backup_error 'No se pudo subir la copia con rclone. Se conserva la copia local.'
  status=1
fi
if expired=$(local_archives | expired_archives); then
  while IFS= read -r name; do
    [[ -z $name || $name == "${file##*/}" ]] && continue
    if ! run_logged rm -- "$daily/$name"; then
      backup_error 'No se pudo retirar una copia local vencida.'
      status=1
    fi
  done <<< "$expired"
else
  backup_error 'No se pudo calcular la retención local.'
  status=1
fi
if [[ -n $remote && $status == 0 ]]; then
  if expired=$(run_logged rclone lsf "$remote" --files-only | expired_archives); then
    prefix=$remote
    [[ $prefix == *: || $prefix == */ ]] || prefix+=/
    while IFS= read -r name; do
      [[ -z $name || $name == "${file##*/}" ]] && continue
      if ! run_logged rclone deletefile "$prefix$name" >/dev/null; then
        backup_error 'No se pudo retirar una copia remota vencida con rclone.'
        status=1
      fi
    done <<< "$expired"
  else
    backup_error 'No se pudo listar las copias remotas con rclone. Se conserva la copia local.'
    status=1
  fi
fi
exit "$status"
