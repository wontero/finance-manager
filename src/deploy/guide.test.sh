#!/usr/bin/env bash
set -euo pipefail

root=$(realpath "$(dirname "$0")/../..")
guide="$root/docs/operacion/despliegue.md"
recovery="$root/docs/operacion/recuperacion.md"
for step in 'gpg --version' 'rclone version' '~/bin' '@@log_bin_trust_function_creators' \
  'Database Wizard' 'MIGRATION_DATABASE_URL=' 'READONLY_DATABASE_URL=' 'GOOGLE_CLIENT_ID=' 'GOOGLE_CLIENT_SECRET=' 'FIRST_USER_EMAIL=' \
  'OAUTH_ALLOWED_REDIRECT_URIS=' '/auth/google/callback' 'Application Manager' 'X-Finance-Release' \
  'Diagnóstico de IP de Passenger' 'Claude.ai' 'Efectivo P3' '454,50' 'v_postings' \
  'rclone config' 'rclone authorize' 'backup.passphrase' 'gestor de contraseñas' \
  'CRON_TZ=America/La_Paz' 'MAILTO=' '30 3 * * *' 'flock' 'backup.sh" verify' \
  'backup.sh" restore' 'Delete Database' 'MAX_USERS' 'auth:tokens -- revoke' '--rollback' \
  'recuperacion.md' 'DEPLOY_HEALTH_USER_AGENT' '406 Not Acceptable'; do
  grep -Fq -- "$step" "$guide" || { echo "S9: falta $step" >&2; exit 1; }
done
for scenario in 'pierde el VPS' 'pierde la frase' 'despliegue rompe la base'; do
  grep -Fiq -- "$scenario" "$recovery" || { echo "S9: falta $scenario" >&2; exit 1; }
done
if grep -Eq 'BEGIN [A-Z ]*PRIVATE KEY|gh[pousr]_[[:alnum:]]{20,}|github_pat_[[:alnum:]_]{20,}|otpauth://totp/|ya29\.[[:alnum:]_-]{20,}|GOOGLE_CLIENT_SECRET=[[:alnum:]_-]{20,}|[_"]token[" ]*[:=][ "]+[[:alnum:]_.-]{20,}|mysql://[^: /]+:[^C ]+@' \
  "$guide" "$recovery"; then
  echo 'S9: se detectó un patrón de credenciales en la documentación' >&2
  exit 1
fi
echo 'PASA M-007 S9'

probes=$(grep -E '^[[:space:]]*curl[[:space:]].*finanzasmateo\.ingetech\.biz' "$guide")
while IFS= read -r probe; do
  [[ $probe == *' -A "FinanceManager-deploy/1.0" '* ]] || {
    echo "M-014 S4: falta el User-Agent en $probe" >&2
    exit 1
  }
done <<< "$probes"
echo 'PASA M-014 S4'
