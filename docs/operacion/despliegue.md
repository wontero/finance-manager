# Despliegue en cPanel

Ejecuta estos pasos desde cPanel y la terminal del VPS como el usuario `ingete7`. El proyecto se instala en `~/apps/finanzasmateo`, fuera de directorios públicos. Este spike usa una base vacía y publica una herramienta `ping` sin autenticación.

## 1. Crea el subdominio y comprueba HTTPS

1. En cPanel, abre **Domains → Create A New Domain** e introduce `finanzasmateo.ingetech.biz`. Desmarca la opción de compartir el directorio público y acepta un directorio independiente para el subdominio. La aplicación se registra en otro paso. [Crear un dominio en cPanel](https://docs.cpanel.net/cpanel/domains/domains/create-a-new-domain/)
2. Si el DNS se administra fuera de cPanel, crea el registro del subdominio en el proveedor que gestiona `ingetech.biz` y apúntalo al VPS.
3. En **SSL/TLS Status**, incluye el subdominio en AutoSSL y pulsa **Run AutoSSL** si está disponible. Abre `https://finanzasmateo.ingetech.biz/` y verifica que el navegador acepta el certificado. Antes de registrar la app puede aparecer una página de cPanel o un 404. [SSL/TLS Status](https://docs.cpanel.net/cpanel/security/ssl-tls-status/)

## 2. Prepara MariaDB y el entorno

1. Abre **Databases → Database Wizard**. Crea una base vacía y un usuario exclusivo de la aplicación con una contraseña generada. Marca solo **SELECT** para esa base. Anota los nombres completos que muestra cPanel, incluido su prefijo si lo añadió. [Database Wizard](https://docs.cpanel.net/cpanel/databases/database-wizard/)
2. Abre **Advanced → Terminal** o entra por SSH con el usuario de cPanel. Crea un directorio privado y abre el archivo de entorno.

   ```bash
   app_dir="$HOME/apps/finanzasmateo"
   mkdir -p "$app_dir"
   mkdir -m 700 -p "$app_dir/shared"
   touch "$app_dir/shared/.env"
   chmod 600 "$app_dir/shared/.env"
   nano "$app_dir/shared/.env"
   ```

3. Añade una línea como esta con los nombres y la contraseña del primer paso. Codifica en porcentaje los caracteres reservados de la contraseña. Por ejemplo, escribe `%40` para `@`. Guarda el archivo con **Ctrl+O**, **Enter** y **Ctrl+X** si usas Nano.

   ```dotenv
   DATABASE_URL=mysql://ingete7_USUARIO:CONTRASENA_CODIFICADA@localhost:3306/ingete7_BASE
   ```

   Node carga el archivo al arrancar. Puedes definir `APP_VERSION` para cambiar la versión reportada en `/health` y `ping`. Con la configuración por defecto, el servidor usa el build de `src/web/dist` y Passenger asigna su propio socket. Si ejecutas `node app.js` directamente, `PORT` controla el puerto y vale 3000 por defecto. [Asignación de puertos en Passenger](https://www.phusionpassenger.com/docs/advanced_guides/in_depth/node/reverse_port_binding.html)

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

Cuando `main` en GitHub contenga esta misión, ejecuta los siguientes comandos en la misma terminal. Si abriste otra, define de nuevo `app_dir`, `GIT_SSH_COMMAND` y `repo_url`.

```bash
export DEPLOY_REPO_URL="$repo_url"
git init --bare "$app_dir/repo"
git --git-dir="$app_dir/repo" fetch --no-tags "$repo_url" main
bootstrap=$(mktemp)
git --git-dir="$app_dir/repo" show FETCH_HEAD:src/deploy/deploy.sh > "$bootstrap"
bash "$bootstrap" --bootstrap
rm -f -- "$bootstrap"
```

`--bootstrap` compila `main` y crea `current` solo durante la instalación inicial. Comprueba que el script indique que preparó la release antes de registrarla. La verificación HTTPS se hace en el siguiente paso, una vez que exista la ruta de Passenger.

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

```bash
app_dir="$HOME/apps/finanzasmateo"
export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/finance_manager_deploy -o IdentitiesOnly=yes"
bash "$app_dir/current/src/deploy/deploy.sh" main
bash "$app_dir/current/src/deploy/deploy.sh" --rollback
```

Ejecuta el segundo comando solo si necesitas volver a la release que estaba activa antes. También puedes pasar una rama, etiqueta o SHA que el remoto exponga. El script construye la release antes de mover `current`, comprueba que responde esa release y vuelve a la anterior si falla. Conserva hasta cinco releases, incluidas la activa y la anterior.

Puedes cambiar las rutas con `DEPLOY_ROOT`, `DEPLOY_RELEASES_DIR`, `DEPLOY_SHARED_DIR` y `DEPLOY_REPO_DIR`. Usa `DEPLOY_REPO_URL` si cambia el origen, `DEPLOY_NODE_BIN` si Node 22 está en otro directorio y `DEPLOY_HEALTH_URL` si cambia la URL de salud. Los reintentos usan `DEPLOY_HEALTH_ATTEMPTS` (10) y `DEPLOY_HEALTH_DELAY` (3 segundos).

### Cuando se incorporen las migraciones

Si la release trae un script npm `migrate`, prepara `shared/mysql.cnf` con permisos 600. Dentro de la sección `[client]`, define `host`, `port`, `user` y `password` para una cuenta separada con permisos de copia y restauración sobre esa base. Exporta `DEPLOY_DB_NAME` con el nombre exacto de la base que migrará el script. Si el archivo está en otro lugar, indica su ruta con `DEPLOY_DB_OPTIONS`.

Ensaya la copia y restauración en una base desechable y detén las escrituras durante la ventana de migración. Si falla `migrate`, el script repone la base desde la copia en `shared/backups`, lo cual reemplaza los datos de esa base con los del momento del respaldo. El rollback de código por fallo de salud o por `--rollback` conserva el esquema resultante de una migración exitosa. Planifica las migraciones para que la versión anterior siga funcionando durante ese intervalo. [Copia lógica de MariaDB](https://mariadb.com/docs/server/clients-and-utilities/backup-restore-and-import-clients/mariadb-dump)

## Si algo falla

- **HTTPS o 404**. Comprueba DNS, AutoSSL, el dominio de Application Manager y la ruta literal de la app.
- **500 o cabecera de release antigua**. Revisa `~/apps/finanzasmateo/shared/logs/` desde **File Manager**, o `~/apps/finanzasmateo/current/logs/` mientras haya una release activa. Comprueba la versión de Node seleccionada para Passenger y que `current` apunte a la release compilada. Para pedir otro reinicio, toca `current/tmp/restart.txt`. Los errores recientes de Apache aparecen en **Metrics → Errors**. [Logs de Application Manager](https://docs.cpanel.net/cpanel/software/application-manager/#log-files), [Errores de Apache en cPanel](https://docs.cpanel.net/cpanel/metrics/errors/)
- **MariaDB no disponible**. Revisa los nombres completos, permisos de la base y codificación de la contraseña en `shared/.env`. Toca `current/tmp/restart.txt` después de guardar cambios.
- **MCP falla**. Comprueba la URL completa y prueba `initialize` con el comando anterior. Si pasa en la terminal, revisa que el conector esté habilitado en el chat y que el celular use la misma cuenta y espacio de trabajo.
