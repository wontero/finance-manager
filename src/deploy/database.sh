#!/usr/bin/env bash

database_script_dir=${BASH_SOURCE[0]%/*}
strict_session="SET SESSION sql_mode='STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION,ERROR_FOR_DIVISION_BY_ZERO', time_zone='+00:00'"

migration_mysql() {
  run_logged mysql --defaults-file="$options" --database="$database" \
    --init-command="$strict_session" --skip-force --default-character-set=utf8mb4 "$@"
}

require_trigger_privileges() {
  local result binlog trust trigger super foreign_definers
  result=$(migration_mysql --batch --skip-column-names --raw \
    --execute="$(cat -- "$database_script_dir/trigger-preflight.sql")") || return 1
  if [[ ! $result =~ ^[01]$'\t'[01]$'\t'[01]$'\t'[01]$'\t'[01]$ ]]; then
    echo 'No se pudieron comprobar los permisos de triggers de MariaDB.' >&2
    return 1
  fi
  IFS=$'\t' read -r binlog trust trigger super foreign_definers <<< "$result"
  if [[ $binlog == 1 && $trust == 0 && $super == 0 ]]; then
    echo 'Pide al administrador que habilite log_bin_trust_function_creators para crear y restaurar triggers con el binlog activo.' >&2
    return 1
  fi
  if [[ $trigger == 0 ]]; then
    echo 'Pide al administrador el privilegio TRIGGER sobre la base principal para el usuario de migración.' >&2
    return 1
  fi
  if [[ $foreign_definers == 1 ]]; then
    echo 'Pide al administrador que compruebe que las vistas y los triggers de la base principal pertenezcan al usuario de migración.' >&2
    return 1
  fi
}

backup_database() {
  if [[ -n ${backup:-} ]]; then
    dump_database > "$backup"
  else
    dump_database
  fi
}

dump_database() {
  require_trigger_privileges || return 1
  local -a dump=(mysqldump --defaults-file="$options" --single-transaction
    --tz-utc --default-character-set=utf8mb4 --no-create-db --skip-add-drop-database --skip-force
    --skip-add-locks --skip-disable-keys)
  # Keep trigger definitions after all table data, including data from later tables.
  run_logged "${dump[@]}" --skip-triggers "$database" |
    awk '1; END { if (!NR) exit 1 }' || return 1
  if [[ -z ${backup:-} ]]; then
    printf '%s\n' '-- FinanceManager: triggers' || return 1
  fi
  run_logged "${dump[@]}" --triggers --no-data --no-create-info "$database"
}

restore_database() {
  [[ -s $backup ]] && require_trigger_privileges || return 1
  local drops
  drops=$(migration_mysql --batch --skip-column-names --raw --execute="
      SELECT CONCAT('DROP ', IF(TABLE_TYPE = 'VIEW', 'VIEW', 'TABLE'), ' ',
                    CHAR(96), REPLACE(TABLE_NAME, CHAR(96), REPEAT(CHAR(96), 2)), CHAR(96), ';')
      FROM information_schema.tables
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE IN ('BASE TABLE', 'VIEW')
      ORDER BY TABLE_TYPE DESC, TABLE_NAME") || return 1
  {
    printf 'SET FOREIGN_KEY_CHECKS=0;\n%s\n' "$drops"
    cat -- "$backup" || exit 1
    printf '\nSET FOREIGN_KEY_CHECKS=1;\n'
  } | migration_mysql --binary-mode
}
