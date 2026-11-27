# Changelog

All notable changes to FinanceManager are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### AÃ±adido

- GuÃ­a de primeros pasos en Claude con estado del usuario y carga de capturas.

- Metas de ahorro y topes de gasto en MCP, con avance multimoneda, bitÃ¡cora, reversiÃ³n y vistas de consulta por usuario.

- SecciÃ³n **Cuenta** para descargar los datos propios con montos exactos y borrar la cuenta, con un nuevo inicio de sesiÃ³n de Google cuando la sesiÃ³n supera diez minutos.
- PÃ¡gina pÃºblica **Privacidad y tÃ©rminos** y panel de mÃ©tricas agregadas por canal, accesible con la cuenta de Google configurada.
- Pantalla de cuentas con saldos y totales por moneda, archivadas y acceso a movimientos filtrados.
- Esquema y ledger con propiedad por usuario, migraciÃ³n de los datos existentes al usuario #1 y topes contables configurables por usuario.
- Dashboard web con inicio de sesiÃ³n, resumen, movimientos con filtros, informes y deshacer desde la actividad.
- Herramienta MCP `actualizar_tipo_de_cambio_oficial` para registrar el tipo oficial USD/BOB vigente vÃ­a CUCU, un tercero sin afiliaciÃ³n al BCB, y conservar las cotizaciones ya registradas para esa fecha.

### Cambiado

- Las instrucciones del servidor MCP exigen respuestas en una línea y explicaciones breves cuando se solicitan.

- Inicio de sesiÃ³n web y autorizaciÃ³n de Claude mediante Google OpenID Connect. Los cÃ³digos, tokens y sesiones pertenecen a cada usuario. La migraciÃ³n invalida las credenciales anteriores y requiere reconectar Claude.
- Registro con cupo configurable y lÃ­mite compartido de peticiones por usuario en el dashboard y MCP.
- `consulta_sql` vuelve a estar disponible en MCP con vistas que filtran por usuario y conservan las cotizaciones oficiales compartidas.

- Las instrucciones del servidor MCP piden respuestas breves y resultados finales sin cÃ¡lculos intermedios.
- Los tipos oficiales USD/BOB de CUCU se comparten, incluidas las cotizaciones histÃ³ricas. La valuaciÃ³n usa el tipo mÃ¡s reciente hasta la fecha solicitada y, en caso de empate, prefiere el del usuario.

### Corregido

- La exportaciÃ³n incluye los importes decimales de la bitÃ¡cora y preserva con exactitud el numerador del interÃ©s pendiente.

- El servidor advierte si el usuario #1 sigue sin vincular y ya existen otros usuarios. La prueba del lÃ­mite por minuto usa un reloj controlado.
- Las consultas SQL validan las fuentes en grupos con operaciones de conjuntos y reintentan la limpieza de mapeos ante un interbloqueo.
- Las respuestas MCP incluyen los datos estructurados en el texto para clientes que no leen `structuredContent`.
- La comprobaciÃ³n de salud del despliegue usa un User-Agent propio para evitar el rechazo de ModSecurity al User-Agent por defecto de `curl`.

## [0.1.0] - sin fecha

### AÃ±adido

- **Contabilidad:** cuentas, categorÃ­as, etiquetas, campos personalizados, partida doble, movimientos, transferencias multimoneda, conciliaciÃ³n, tipos de cambio y patrimonio.
- **PrÃ©stamos:** prÃ©stamos hechos y recibidos, cÃ¡lculo de interÃ©s simple y abonos.
- **Interfaz MCP:** herramientas en espaÃ±ol para registrar, consultar, importar lotes y deshacer; SQL de lectura sobre vistas.
- **OperaciÃ³n:** autenticaciÃ³n OAuth 2.1 con TOTP, copias cifradas, restauraciÃ³n y despliegue en cPanel/Passenger.
- **Calidad:** pruebas unitarias, HTTP, integraciÃ³n con MariaDB y suites Bash.

### Seguridad

- OAuth con PKCE, tokens revocables y autenticaciÃ³n de segundo factor.
- Base de lectura separada con permisos limitados a vistas financieras.
- BitÃ¡cora de auditorÃ­a y copias cifradas.
