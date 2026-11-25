# Entorno local

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

Completa `.env` con las rutas de la instancia local y claves distintas para `finance_dev`, `finance_migration`, `finance_readonly` y `finance_shutdown`. Conserva el host y puerto local en las URLs. Codifica en porcentaje los caracteres reservados de las contraseñas.

Para preparar una instancia nueva, extrae el ZIP de MariaDB fuera del repositorio. Ejecuta lo siguiente una vez, con un directorio de datos nuevo y una clave de administración local. Tras iniciar el servidor en primer plano, abre otra sesión de PowerShell para conectarte como `root`.

```powershell
$mariaHome = Join-Path $env:LOCALAPPDATA 'FinanceManager/mariadb-10.6.28-winx64'
$mariaData = Join-Path $env:LOCALAPPDATA 'FinanceManager/data'
$rootPassword = Read-Host 'Contraseña local de root' -AsSecureString
$rootCredential = [pscredential]::new('root', $rootPassword)
& "$mariaHome/bin/mariadb-install-db.exe" "--datadir=$mariaData" --port=3308 "--password=$($rootCredential.GetNetworkCredential().Password)"
& "$mariaHome/bin/mariadbd.exe" --no-defaults "--basedir=$mariaHome" "--datadir=$mariaData" --bind-address=127.0.0.1 --port=3308 --skip-name-resolve --console
```

Para una instancia nueva, conecta con `mariadb.exe --no-defaults --host=127.0.0.1 --port=3308 --user=root --password` desde la carpeta `bin` de MariaDB. Crea la cuenta local de apagado con la contraseña de `MARIADB_SHUTDOWN_URL`.

```sql
CREATE USER 'finance_shutdown'@'127.0.0.1' IDENTIFIED BY 'CLAVE_SHUTDOWN';
GRANT SHUTDOWN ON *.* TO 'finance_shutdown'@'127.0.0.1';
```

Con MariaDB en ejecución, usa `npm run db:setup` para crear o actualizar las cuatro bases locales y los tres usuarios de datos. Proporciona la clave de root solo a la sesión de preparación.

```powershell
$rootPassword = Read-Host 'Contraseña local de root' -AsSecureString
$rootCredential = [pscredential]::new('root', $rootPassword)
$env:MARIADB_ADMIN_URL = 'mysql://root:' + [uri]::EscapeDataString($rootCredential.GetNetworkCredential().Password) + '@127.0.0.1:3308'
try {
    npm run db:setup
} finally {
    Remove-Item Env:MARIADB_ADMIN_URL
}
```

Si ya preparaste la instancia, usa `npm run db:start` antes de `db:setup`. Usa `npm run db:stop` para detenerla, incluso si arrancó en primer plano.
