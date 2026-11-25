# Changelog

All notable changes to FinanceManager are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Añadido

- Dashboard web con inicio de sesión, resumen, movimientos con filtros, informes y deshacer desde la actividad.
- Herramienta MCP `actualizar_tipo_de_cambio_oficial` para registrar el tipo oficial USD/BOB vigente vía CUCU, un tercero sin afiliación al BCB, y conservar las cotizaciones ya registradas para esa fecha.

### Cambiado

- Las instrucciones del servidor MCP piden respuestas breves y resultados finales sin cálculos intermedios.

### Corregido

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
