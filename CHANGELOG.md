# Changelog

All notable changes to FinanceManager are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Añadido

- Guía de primeros pasos en Claude con estado del usuario y carga de capturas.

- Metas de ahorro y topes de gasto en MCP, con avance multimoneda, bitácora, reversión y vistas de consulta por usuario.

- Sección **Cuenta** para descargar los datos propios con montos exactos y borrar la cuenta, con un nuevo inicio de sesión de Google cuando la sesión supera diez minutos.
- Página pública **Privacidad y términos** y panel de métricas agregadas por canal, accesible con la cuenta de Google configurada.
- Pantalla de cuentas con saldos y totales por moneda, archivadas y acceso a movimientos filtrados.
- Esquema y ledger con propiedad por usuario, migración de los datos existentes al usuario #1 y topes contables configurables por usuario.
- Dashboard web con inicio de sesión, resumen, movimientos con filtros, informes y deshacer desde la actividad.
- Herramienta MCP `actualizar_tipo_de_cambio_oficial` para registrar el tipo oficial USD/BOB vigente vía CUCU, un tercero sin afiliación al BCB, y conservar las cotizaciones ya registradas para esa fecha.

### Cambiado
- Las instrucciones MCP incluyen el enlace al dashboard web de la instancia.
- Las instrucciones del servidor MCP exigen respuestas en una línea y explicaciones breves cuando se solicitan.

- Inicio de sesión web y autorización de Claude mediante Google OpenID Connect. Los códigos, tokens y sesiones pertenecen a cada usuario. La migración invalida las credenciales anteriores y requiere reconectar Claude.
- Registro con cupo configurable y límite compartido de peticiones por usuario en el dashboard y MCP.
- `consulta_sql` vuelve a estar disponible en MCP con vistas que filtran por usuario y conservan las cotizaciones oficiales compartidas.

- Las instrucciones del servidor MCP piden respuestas breves y resultados finales sin cálculos intermedios.
- Los tipos oficiales USD/BOB de CUCU se comparten, incluidas las cotizaciones históricas. La valuación usa el tipo más reciente hasta la fecha solicitada y, en caso de empate, prefiere el del usuario.

### Corregido

- La exportación incluye los importes decimales de la bitácora y preserva con exactitud el numerador del interés pendiente.

- El servidor advierte si el usuario #1 sigue sin vincular y ya existen otros usuarios. La prueba del límite por minuto usa un reloj controlado.
- Las consultas SQL validan las fuentes en grupos con operaciones de conjuntos y reintentan la limpieza de mapeos ante un interbloqueo.
- Las respuestas MCP incluyen los datos estructurados en el texto para clientes que no leen `structuredContent`.
- La comprobación de salud del despliegue usa un User-Agent propio para evitar el rechazo de ModSecurity al User-Agent por defecto de `curl`.

## [0.1.0] - sin fecha

### Añadido

- **Contabilidad:** cuentas, categorías, etiquetas, campos personalizados, partida doble, movimientos, transferencias multimoneda, conciliación, tipos de cambio y patrimonio.
- **Préstamos:** préstamos hechos y recibidos, cálculo de interés simple y abonos.
- **Interfaz MCP:** herramientas en español para registrar, consultar, importar lotes y deshacer; SQL de lectura sobre vistas.
- **Operación:** autenticación OAuth 2.1 con TOTP, copias cifradas, restauración y despliegue en cPanel/Passenger.
- **Calidad:** pruebas unitarias, HTTP, integración con MariaDB y suites Bash.

### Seguridad

- OAuth con PKCE, tokens revocables y autenticación de segundo factor.
- Base de lectura separada con permisos limitados a vistas financieras.
- Bitácora de auditoría y copias cifradas.
