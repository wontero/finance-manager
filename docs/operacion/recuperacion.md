# Recuperación de Finance Manager

Guarda fuera del VPS la frase de GPG, una copia de la configuración de rclone, la clave `TOTP_ENCRYPTION_KEY`, los nombres de las bases y del definidor de MariaDB (`CURRENT_USER()` con la cuenta de migración) y la revisión que desplegaste. Usa el gestor de contraseñas para la configuración y credenciales. El volcado cifrado incluye datos financieros y tablas de autenticación de la base principal. Guarda los volcados en destinos privados.

## Si se pierde el VPS

1. Prepara en el servidor nuevo Node, las herramientas, el directorio privado, las cuentas y las dos bases del [despliegue](despliegue.md). Usa la versión de aplicación que produjo el volcado o una versión posterior compatible con sus migraciones. Recrea la cuenta definidora de las vistas y triggers con el mismo nombre y host. Si cPanel impone otro nombre, acuerda con el administrador cómo gestionar los definidores antes de importar.
2. Recupera el acceso de lectura al remoto de Drive. Usa el archivo de configuración guardado con permisos 600, o reautoriza el mismo remoto. Comprueba que `rclone lsf "$BACKUP_RCLONE_REMOTE" --files-only` lista las copias. Descarga una copia por nombre a un directorio privado con `rclone copy`, empezando por la última anterior a la pérdida.
3. Crea `shared/backup.passphrase` con permisos 600 y usa un editor privado para pegar la frase recuperada en una sola línea. Recupera la clave TOTP en el nuevo `shared/.env`, actualiza las credenciales y las rutas de la nueva instalación, y prepara `shared/mysql.cnf`. Verifica la copia con `backup.sh verify` desde el código obtenido del repositorio privado.
4. Con la aplicación y el cron todavía detenidos, ejecuta `DEPLOY_DB_NAME=NOMBRE_BASE bash src/deploy/backup.sh restore RUTA_COPIA` desde la revisión recuperada. Escribe el nombre de la base al confirmar. Comprueba los recuentos, saldos de muestra, claves foráneas y triggers. Si falla la importación, conserva la copia y corrige la causa antes de repetirla.
5. Completa el despliegue de la aplicación. Ejecuta `npm run migrate` con la configuración del nuevo servidor para regenerar las vistas en la base `_ro`. Comprueba `/health`, las vistas con la cuenta de solo lectura y las herramientas con OAuth. Si cambió la URL pública o no recuperaste la clave TOTP, vuelve a autorizar el conector y, en caso de clave nueva, ejecuta `auth:setup` para reemplazar el TOTP y revocar los tokens anteriores. Reactiva el cron al final y verifica que produce y sube una copia nueva.

## Si se pierde la frase

Recupera la frase del gestor de contraseñas y prueba `backup.sh verify` en una copia descargada. Si se perdieron todas las copias de la frase, los archivos GPG que dependían de ella son irrecuperables. Comprueba si queda la base original, un volcado de despliegue o una copia del proveedor.

Si conservas la base, guarda aparte las copias existentes, genera una frase nueva y custódiala fuera del VPS. Usa un directorio remoto dedicado a la nueva serie y un directorio `daily` local nuevo. Ejecuta la prueba de restauración de la [guía de despliegue](despliegue.md#9-ensaya-una-restauración-desde-drive) antes de dar el servicio por recuperado.

## Si un despliegue rompe la base

1. Suspende el cron y las escrituras de la aplicación. Lee `shared/logs/deploy-<release>.log` y confirma el estado de `current`, la base y sus triggers. Conserva fuera de la rotación privada el volcado de ese despliegue si vas a tardar en recuperarlo.
2. Si fallaron la migración y su restauración, corrige el error indicado y ejecuta el comando de reintento que figura en el log. Usa el volcado de esa migración y la referencia conservada en el repositorio local. Si el volcado ya no está disponible o la base se dañó en otro momento, usa la última copia diaria verificada anterior al incidente. Restaurar una copia diaria pierde los cambios posteriores a su fecha.
3. Comprueba las tablas y los triggers de la base principal. Ejecuta el migrador desde la release compatible para regenerar `_ro`. Si el código activo quedó incompatible, usa `deploy.sh --rollback` tras restaurar un esquema compatible con la release anterior. El rollback cambia la release de código. La restauración de datos se ejecuta como paso propio.
4. Comprueba `/health`, el acceso de solo lectura, los saldos de muestra y el estado de OAuth antes de habilitar escrituras. Reactiva el cron después de verificar una copia nueva.
