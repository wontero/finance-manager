# Despliegue en cPanel

Ejecuta estos pasos desde cPanel y la terminal del VPS como el usuario `ingete7`. El proyecto se instala en `~/apps/finanzasmateo`, fuera de directorios públicos. Este spike usa una base vacía y publica una herramienta `ping` sin autenticación.

## 1. Crea el subdominio y comprueba HTTPS

1. En cPanel, abre **Domains → Create A New Domain** e introduce `finanzasmateo.ingetech.biz`. Desmarca la opción de compartir el directorio público y acepta un directorio independiente para el subdominio. La aplicación se registra en otro paso. [Crear un dominio en cPanel](https://docs.cpanel.net/cpanel/domains/domains/create-a-new-domain/)
2. Si el DNS se administra fuera de cPanel, crea el registro del subdominio en el proveedor que gestiona `ingetech.biz` y apúntalo al VPS.
3. En **SSL/TLS Status**, incluye el subdominio en AutoSSL y pulsa **Run AutoSSL** si está disponible. Abre `https://finanzasmateo.ingetech.biz/` y verifica que el navegador acepta el certificado. Antes de registrar la app puede aparecer una página de cPanel o un 404. [SSL/TLS Status](https://docs.cpanel.net/cpanel/security/ssl-tls-status/)

## 2. Prepara MariaDB y el entorno

1. Abre **Databases → Database Wizard** y **Manage My Databases**. Crea dos bases vacías (por ejemplo, `ingete7_finanzas` y `ingete7_finanzas_ro`) y tres usuarios con contraseñas distintas. Anota los nombres completos que muestra cPanel, incluido el prefijo. Al añadir cada usuario a una base, marca las casillas indicadas. [Database Wizard](https://docs.cpanel.net/cpanel/databases/database-wizard/)

   | Usuario de ejemplo | Base principal                                 | Base de solo lectura |
   | ------------------ | ---------------------------------------------- | -------------------- |
   | `ingete7_finapp`   | **SELECT**, **INSERT**, **UPDATE**, **DELETE** | Sin asignación       |
   | `ingete7_finmig`   | **ALL PRIVILEGES**                             | **ALL PRIVILEGES**   |
   | `ingete7_finro`    | Sin asignación                                 | **SELECT**           |

   La cuenta de migración crea las vistas como su propia cuenta definidora. Conserva esa cuenta mientras existan las vistas. Mantén la base de consulta dedicada a las vistas que crea el proyecto. [Permisos de las vistas en MariaDB](https://mariadb.com/docs/server/server-usage/views/create-view)

2. Abre **Advanced → Terminal** o entra por SSH con el usuario de cPanel. Crea un directorio privado y abre el archivo de entorno.

   ```bash
   app_dir="$HOME/apps/finanzasmateo"
   mkdir -p "$app_dir"
   mkdir -m 700 -p "$app_dir/shared"
   touch "$app_dir/shared/.env"
   chmod 600 "$app_dir/shared/.env"
   nano "$app_dir/shared/.env"
   ```

3. Añade los nombres y las contraseñas del primer paso. En las URLs, codifica en porcentaje los caracteres reservados, por ejemplo `%40` para `@`. Guarda el archivo con **Ctrl+O**, **Enter** y **Ctrl+X** si usas Nano.

   ```dotenv
   DATABASE_URL=mysql://ingete7_finapp:CLAVE_APP_CODIFICADA@localhost:3306/ingete7_finanzas
   MIGRATION_DATABASE_URL=mysql://ingete7_finmig:CLAVE_MIG_CODIFICADA@localhost:3306/ingete7_finanzas
   READONLY_DATABASE_NAME=ingete7_finanzas_ro
   READONLY_DATABASE_URL=mysql://ingete7_finro:CLAVE_RO_CODIFICADA@localhost:3306/ingete7_finanzas_ro
   ```

   Node carga el archivo al arrancar. Puedes definir `APP_VERSION` para cambiar la versión reportada en `/health` y `ping`. Con la configuración por defecto, el servidor usa el build de `src/web/dist` y Passenger asigna su propio socket. Si ejecutas `node app.js` directamente, `PORT` controla el puerto y vale 3000 por defecto. [Asignación de puertos en Passenger](https://www.phusionpassenger.com/docs/advanced_guides/in_depth/node/reverse_port_binding.html)

4. Prepara `shared/mysql.cnf` antes del primer despliegue. Usa el mismo usuario, host y credenciales de `MIGRATION_DATABASE_URL`. La contraseña de este archivo usa la sintaxis de MariaDB, sin codificarla como URL.

   ```bash
   touch "$app_dir/shared/mysql.cnf"
   chmod 600 "$app_dir/shared/mysql.cnf"
   nano "$app_dir/shared/mysql.cnf"
   ```

   ```ini
   [client]
   user=ingete7_finmig
   password="CLAVE_MIG"
   host=localhost
   port=3306
   protocol=tcp
   ```

   Si las cuentas de cPanel requieren el socket Unix, define `DATABASE_SOCKET=/ruta/absoluta/mysql.sock` en `shared/.env` para la aplicación y el migrador. En `mysql.cnf`, cambia a `protocol=socket` y añade `socket=/ruta/absoluta/mysql.sock`. [Archivos de opciones de MariaDB](https://mariadb.com/docs/server/server-management/install-and-upgrade-mariadb/configuring-mariadb/configuring-mariadb-with-option-files)

## 3. Añade la deploy key al repositorio

1. En la terminal del VPS, genera una clave exclusiva de este repositorio. Si eliges protegerla con frase de paso, desbloquéala con `ssh-agent` y `ssh-add` antes de desplegar.

   ```bash
   mkdir -m 700 -p "$HOME/.ssh"
   ssh-keygen -t ed25519 -f "$HOME/.ssh/finance_manager_deploy" -C "finance-manager deploy"
   cat "$HOME/.ssh/finance_manager_deploy.pub"
   ```

2. Copia la línea del archivo `.pub` a **Settings → Deploy keys → Add deploy key** en el repositorio privado de GitHub. Deja desmarcada la opción **Allow write access**. Conserva la clave privada en el VPS.
3. Selecciona la clave y comprueba el acceso de lectura. En la primera conexión, compara la huella que muestra SSH con las publicadas por GitHub antes de aceptar. `git ls-remote` debe mostrar la ref de `main`. [Huellas oficiales de GitHub](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints)

   ```bash
   export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/finance_manager_deploy -o IdentitiesOnly=yes"
   repo_url=git@github.com:wontero/finance-manager.git
   git ls-remote --exit-code "$repo_url" refs/heads/main
   ```

## 4. Prepara la primera release

Cuando `main` en GitHub contenga esta misión, ejecuta los siguientes comandos desde una sesión persistente de `tmux` o `screen`, como se explica en el paso 7. Si abriste otra terminal, define de nuevo `app_dir`, `GIT_SSH_COMMAND` y `repo_url`.

```bash
export DEPLOY_REPO_URL="$repo_url"
export DEPLOY_DB_NAME=ingete7_finanzas
git init --bare "$app_dir/repo"
git --git-dir="$app_dir/repo" fetch --no-tags "$repo_url" main
bootstrap=$(mktemp)
git --git-dir="$app_dir/repo" show FETCH_HEAD:src/deploy/deploy.sh > "$bootstrap"
bash "$bootstrap" --bootstrap
rm -f -- "$bootstrap"
```

`--bootstrap` compila `main`, respalda la base principal, aplica sus migraciones y crea `current` solo durante la instalación inicial. Comprueba que el script indique que preparó la release antes de registrarla. La verificación HTTPS se hace en el siguiente paso, una vez que exista la ruta de Passenger.

Si usas `nohup`, sigue el ejemplo del paso 7 con `bash "$bootstrap" --bootstrap` y borra el archivo temporal cuando el proceso haya terminado.

## 5. Registra la app y comprueba la salud

1. Abre **Software → Application Manager → Register Application** e introduce estos valores.

   | Campo                  | Valor                                         |
   | ---------------------- | --------------------------------------------- |
   | Application Name       | Finance Manager                               |
   | Deployment Domain      | `finanzasmateo.ingetech.biz`                  |
   | Base Application URL   | `/`                                           |
   | Application Path       | `apps/finanzasmateo/current`                  |
   | Deployment Environment | Production                                    |
   | Environment Variables  | Deja las variables de la app en `shared/.env` |

2. Pulsa **Deploy**. Usa la ruta literal `current` para que los despliegues posteriores puedan cambiar su destino. El script instala las dependencias con Node 22 y las deja listas para Passenger. [Application Manager](https://docs.cpanel.net/cpanel/software/application-manager/)
3. En la terminal, ejecuta estos comandos y compara el valor de `X-Finance-Release` con el nombre de la release que devuelve el segundo comando.

   ```bash
   curl -fsSi https://finanzasmateo.ingetech.biz/health
   basename "$(readlink "$app_dir/current")"
   ```

   Espera HTTP 200, el nombre `Finance Manager`, `status: "ok"` y `db: "ok"`. `db: "unavailable"` indica que falló la prueba de conexión y `db: "not_configured"` indica que falta `DATABASE_URL`. Abre también `https://finanzasmateo.ingetech.biz/` para comprobar la web.

4. Prueba primero `localhost:3306` como en el paso 2. Si `/health` devuelve `db: "unavailable"` y confirmaste el usuario y sus permisos, busca el socket Unix desde la cuenta de cPanel. Ejecuta `my_print_defaults client client-server client-mariadb | sed -n 's/^--socket=//p'` para mostrar solo la ruta configurada. Si el cliente puede conectarse, confirma la ruta real con `mysql --user=ingete7_USUARIO --password --execute "SHOW VARIABLES LIKE 'socket';"`. [Archivos de opciones de MariaDB](https://mariadb.com/docs/server/server-management/install-and-upgrade-mariadb/configuring-mariadb/configuring-mariadb-with-option-files)

   Añade `DATABASE_SOCKET=/ruta/absoluta/mysql.sock` a `shared/.env`, usando la ruta que encontraste. `DATABASE_URL` sigue aportando el usuario, la contraseña y la base. Con el socket configurado, el servidor omite el host y el puerto. Ejecuta `touch "$app_dir/current/tmp/restart.txt"` para que Passenger relea la configuración y repite `/health`.

cPanel busca `app.js` en la raíz de la aplicación y el cargador documentado de Passenger lo abre con `require()`. El archivo es CommonJS y carga el servidor ESM mediante `import()`. Así se evita depender del soporte de `require(ESM)` del cargador instalado. El script toca `tmp/restart.txt` al activar cada release. [Arranque de Node en cPanel](https://docs.cpanel.net/knowledge-base/web-services/how-to-install-a-node.js-application/), [Arquitectura del cargador Passenger](https://www.phusionpassenger.com/documentation/Design%20and%20Architecture.html), [Despliegues con enlaces de Passenger](https://www.phusionpassenger.com/docs/advanced_guides/deployment_and_scaling/apache/automating_app_updates/)

## 6. Prueba Claude en web y en el celular

1. En Claude.ai, abre **Customize → Connectors → + Add → Add custom connector**. En una organización, usa **Organization settings → Connectors** con el rol que permite añadir conectores.
2. Escribe **Finance Manager** y la URL `https://finanzasmateo.ingetech.biz/mcp`. Elige **No sign in** y guarda el conector.
3. En un chat nuevo de la web, abre **+ → Connectors**, activa **Finance Manager** y pide «Ejecuta la herramienta ping de Finance Manager y muestra la respuesta». Verifica `pong`, la versión y la hora ISO.
4. En el celular, abre la app de Claude con la misma cuenta y espacio de trabajo. Activa el conector en un chat nuevo y repite la prueba.
5. Al terminar, elimina **Finance Manager** en **Customize → Connectors**. Si se añadió desde la organización, elimínalo en **Organization settings → Connectors**. [Configurar y eliminar conectores personalizados](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), [Disponibilidad de conectores remotos](https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors)

El spike usa Streamable HTTP sin sesiones y con respuestas JSON mediante el SDK oficial TypeScript `@modelcontextprotocol/sdk` **1.32.2**. Si pruebas el endpoint a mano, envía los dos tipos de contenido en `Accept` como exige el protocolo. Una petición `GET /mcp` devuelve 405. [Transporte Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [SDK TypeScript](https://ts.sdk.modelcontextprotocol.io/server)

```bash
curl -fsS https://finanzasmateo.ingetech.biz/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"manual","version":"1"}}}'
```

## 7. Despliega cambios y usa rollback

Si están disponibles, abre `tmux new -s finanzas` o `screen -S finanzas` antes de ejecutar el despliegue. Así puedes recuperar la terminal si se corta SSH. Dentro de la sesión, ejecuta lo siguiente.

```bash
app_dir="$HOME/apps/finanzasmateo"
export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/finance_manager_deploy -o IdentitiesOnly=yes"
export DEPLOY_DB_NAME=ingete7_finanzas
bash "$app_dir/current/src/deploy/deploy.sh" main
```

Si estás actualizando desde el spike M-002/M-002B, ejecuta el script de la release nueva para que la primera migración use el mecanismo de restauración actual. Con las variables de los pasos 3 y 4 definidas, sustituye la última línea del ejemplo por estos comandos.

```bash
git --git-dir="$app_dir/repo" fetch --no-tags "$repo_url" main
installer=$(mktemp)
git --git-dir="$app_dir/repo" show FETCH_HEAD:src/deploy/deploy.sh > "$installer"
bash "$installer" main
rm -f -- "$installer"
```

Si ninguno está instalado, define `app_dir`, `GIT_SSH_COMMAND` y `DEPLOY_DB_NAME` como arriba, deja la clave lista para uso sin preguntas y ejecuta el despliegue con `nohup`.

```bash
session_log=$(mktemp "$app_dir/shared/deploy-ssh.XXXXXX.log")
nohup bash "$app_dir/current/src/deploy/deploy.sh" main >"$session_log" 2>&1 </dev/null &
printf 'PID %s · log %s\n' "$!" "$session_log"
tail -f "$session_log"
```

También puedes pasar una rama, etiqueta o SHA que el remoto exponga. El script construye la release antes de mover `current`, comprueba que responde esa release y vuelve a la anterior si falla. En un despliegue normal y en un rollback exige HTTP 200 y la cabecera de la release esperada. Si `shared/.env` define `DATABASE_URL`, exige además `db: "ok"` en el JSON. Conserva hasta cinco releases, incluidas la activa y la anterior.

Para volver a la release anterior, ejecuta `bash "$app_dir/current/src/deploy/deploy.sh" --rollback`. El script muestra el origen y el destino. Escribe `s` para confirmar o pulsa **Enter** para cancelar. Usa `--rollback --yes` si necesitas confirmar desde un proceso sin terminal. Cada rollback exitoso intercambia la release activa y `previous`. Dos seguidos vuelven al punto de partida.

Si se corta SSH, vuelve a conectarte y recupera la sesión con `tmux attach -t finanzas` o `screen -r finanzas`. Con `nohup`, revisa el PID que anotaste con `ps -p PID` y lee el log indicado. Espera a que termine antes de reintentar. Si el proceso ya terminó, compara `readlink "$app_dir/current"` y `readlink "$app_dir/shared/previous"` con la cabecera y el JSON de `/health`. Si el corte ocurrió durante una migración, verifica su resultado y la copia en `shared/backups` antes de repetir el despliegue o restaurar la base.

Puedes cambiar las rutas con `DEPLOY_ROOT`, `DEPLOY_RELEASES_DIR`, `DEPLOY_SHARED_DIR` y `DEPLOY_REPO_DIR`. Usa `DEPLOY_REPO_URL` si cambia el origen, `DEPLOY_NODE_BIN` si Node 22 está en otro directorio y `DEPLOY_HEALTH_URL` si cambia la URL de salud. Los reintentos usan `DEPLOY_HEALTH_ATTEMPTS` (10) y `DEPLOY_HEALTH_DELAY` (3 segundos).

### Copia y restauración de una migración fallida

El volcado de la base principal usa la cuenta de migración de `shared/mysql.cnf`. Si el archivo está en otro lugar, indica su ruta con `DEPLOY_DB_OPTIONS`. `DEPLOY_DB_NAME` debe coincidir con la base de `MIGRATION_DATABASE_URL` y `DATABASE_URL`.

El migrador y el script de despliegue comprueban el privilegio `TRIGGER` de la cuenta sobre la base principal y la configuración del registro binario antes de modificar tablas. Si el binlog está activo y la cuenta carece de `SUPER`, pide al administrador que habilite `log_bin_trust_function_creators`. Ambos comprueban que la cuenta de migración sea la definidora de las vistas y triggers de la base principal. [Variables del registro binario de MariaDB](https://mariadb.com/docs/server/ha-and-performance/standard-replication/replication-and-binary-log-system-variables#log_bin_trust_function_creators)

Los valores por defecto de las marcas `DATETIME(3)` siguen la zona de la sesión. La app y el migrador la fijan en UTC. Para escrituras manuales desde phpMyAdmin o la consola, ejecuta `SET SESSION time_zone = '+00:00';` en la misma conexión antes de escribir.

Ensaya la copia y restauración en una base desechable y detén las escrituras y los cambios de esquema durante la ventana de migración. El volcado guarda primero el esquema y los datos y añade los triggers al final. Si falla `migrate`, el script repite el prechequeo antes de eliminar los objetos de la base principal. Luego carga la copia de `shared/backups` y crea los triggers después de cargar todos los datos. El cliente abre la sesión en modo estricto y UTC. Las cabeceras nativas del volcado ajustan temporalmente el modo SQL para recuperar columnas generadas y restauran el modo al final. Las vistas de consulta se administran con el migrador. Si la recreación de esas vistas se interrumpió, compruébalas tras restaurar la principal. El rollback de código por fallo de salud o por `--rollback` conserva el esquema de una migración exitosa. Planifica las migraciones para que la versión anterior siga funcionando durante ese intervalo. [Copia lógica de MariaDB](https://mariadb.com/docs/server/clients-and-utilities/backup-restore-and-import-clients/mariadb-dump)

## Si algo falla

- **HTTPS o 404**. Comprueba DNS, AutoSSL, el dominio de Application Manager y la ruta literal de la app.
- **500 o cabecera de release antigua**. Revisa `~/apps/finanzasmateo/shared/logs/` desde **File Manager**, o `~/apps/finanzasmateo/current/logs/` mientras haya una release activa. Comprueba la versión de Node seleccionada para Passenger y que `current` apunte a la release compilada. Para pedir otro reinicio, toca `current/tmp/restart.txt`. Los errores recientes de Apache aparecen en **Metrics → Errors**. [Logs de Application Manager](https://docs.cpanel.net/cpanel/software/application-manager/#log-files), [Errores de Apache en cPanel](https://docs.cpanel.net/cpanel/metrics/errors/)
- **MariaDB no disponible**. Revisa los nombres completos, permisos de la base y codificación de la contraseña en `shared/.env`. Toca `current/tmp/restart.txt` después de guardar cambios.
- **Descarga, copia, migración o restauración fallida**. Abre el archivo `shared/logs/deploy-<release>.log` que indica el error. El archivo tiene permisos 600 y contiene el diagnóstico con las credenciales de configuración filtradas.
- **La restauración falló**. Mantén detenidas las escrituras. La base principal puede haber quedado parcial y sin triggers de bitácora. Corrige la causa del error y ejecuta el comando de reintento que muestra el despliegue con la ruta del volcado conservado.
- **MariaDB rechaza crear triggers con el error 1419**. Pide al proveedor que compruebe la configuración de registro binario y si permite a la cuenta de migración crear y restaurar los triggers. [Variables del registro binario de MariaDB](https://mariadb.com/docs/server/ha-and-performance/standard-replication/replication-and-binary-log-system-variables#log_bin_trust_function_creators)
- **MCP falla**. Comprueba la URL completa y prueba `initialize` con el comando anterior. Si pasa en la terminal, revisa que el conector esté habilitado en el chat y que el celular use la misma cuenta y espacio de trabajo.
