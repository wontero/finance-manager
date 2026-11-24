# FinanceManager

## Propósito

Aplicación para gestionar finanzas personales: ingresos, gastos, presupuestos e informes.

## Requisitos previos

- [Node.js 22](https://nodejs.org/en/download) y npm. Se verificó con Node 22.23.5 y npm 10.
- [MariaDB 10.6 para Windows](https://archive.mariadb.org/mariadb-10.6.28/winx64-packages/) para las pruebas de integración. El entorno local usa el ZIP oficial 10.6.28 y escucha en `127.0.0.1:3308`.

## Configuración

Activa el Node 22 portable en cada sesión de PowerShell que uses para el proyecto. Ajusta la ruta si lo extraes en otra carpeta.

```powershell
$toolchain = Join-Path $env:LOCALAPPDATA 'FinanceManager'
$env:Path = (Join-Path $toolchain 'node-v22.23.5-win-x64') + ';' + $env:Path
node -v
npm ci
Copy-Item .env.example .env
```

Si ya tienes la instancia local configurada, completa `.env` con sus rutas y credenciales. `DATABASE_URL` apunta a `finance_dev`. `MARIADB_SHUTDOWN_URL` usa la misma dirección y puerto. Codifica los caracteres reservados de las contraseñas al escribirlas en una URL.

Para preparar una instancia nueva, extrae el ZIP de MariaDB fuera del repositorio. Ejecuta lo siguiente una vez, con un directorio de datos nuevo y una clave de administración local. Tras iniciar el servidor en primer plano, abre otra sesión de PowerShell para conectarte como `root`.

```powershell
$mariaHome = Join-Path $env:LOCALAPPDATA 'FinanceManager/mariadb-10.6.28-winx64'
$mariaData = Join-Path $env:LOCALAPPDATA 'FinanceManager/data'
$rootPassword = Read-Host 'Contraseña local de root' -AsSecureString
$rootCredential = [pscredential]::new('root', $rootPassword)
& "$mariaHome/bin/mariadb-install-db.exe" "--datadir=$mariaData" --port=3308 "--password=$($rootCredential.GetNetworkCredential().Password)"
& "$mariaHome/bin/mariadbd.exe" --no-defaults "--basedir=$mariaHome" "--datadir=$mariaData" --bind-address=127.0.0.1 --port=3308 --skip-name-resolve --console
```

Conecta con `mariadb.exe --no-defaults --host=127.0.0.1 --port=3308 --user=root --password` desde la carpeta `bin` de MariaDB. Ejecuta el SQL con dos claves locales distintas y úsalas en `.env`.

```sql
CREATE DATABASE finance_dev CHARACTER SET utf8mb4;
CREATE DATABASE finance_test CHARACTER SET utf8mb4;
CREATE USER 'finance_dev'@'127.0.0.1' IDENTIFIED BY 'CLAVE_DEV';
GRANT ALL PRIVILEGES ON `finance\_dev`.* TO 'finance_dev'@'127.0.0.1';
GRANT ALL PRIVILEGES ON `finance\_test`.* TO 'finance_dev'@'127.0.0.1';
CREATE USER 'finance_shutdown'@'127.0.0.1' IDENTIFIED BY 'CLAVE_SHUTDOWN';
GRANT SHUTDOWN ON *.* TO 'finance_shutdown'@'127.0.0.1';
```

Ejecuta `npm run db:stop` para cerrar la sesión del servidor en primer plano después de preparar `.env`. A partir de entonces, usa `npm run db:start` y `npm run db:stop` para iniciar y detener la instancia bajo demanda.

## Compilar y ejecutar

- `npm run dev` inicia Express y Vite. El endpoint de salud está en `http://localhost:3000/health` y la web se abre en `http://localhost:5173`. Puedes cambiar el puerto de Express con `PORT` en `.env`.
- `npm run build` genera `dist/` en cada workspace. Ejecuta el servidor compilado con `node --env-file-if-exists=.env src/server/dist/index.js`.

## Pruebas

- `npm test` ejecuta las pruebas unitarias y HTTP sin MariaDB.
- `npm run test:integration` requiere `npm run db:start`. Usa las credenciales de `DATABASE_URL` para probar el motor y los permisos de `finance_dev` en `finance_test`.
- `npm run lint`, `npm run typecheck` y `npm run format:check` verifican el código y el formato.

## Estructura del repositorio

- `src/core/` contiene el código compartido.
- `src/server/` contiene la app HTTP, su punto de entrada y los scripts de MariaDB local.
- `src/web/` contiene la aplicación React y la configuración de shadcn/ui.
- `src/scripts/` contiene la comprobación de versión de Node para las pruebas.
- `docs/` contiene la documentación del proyecto.
