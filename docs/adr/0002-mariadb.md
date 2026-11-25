# ADR-0002 — MariaDB como base de datos

## Estado
Aceptada (2026-11-24).

## Contexto
El VPS ya tiene MariaDB 10.6 administrada por cPanel. Claude podrá hacer consultas SQL libres de análisis, que nunca deben poder modificar datos. Puede haber en el futuro una instancia por persona (familia/amigos), cada una con su base.

## Opciones consideradas
- **PostgreSQL**: JSONB potente y roles de solo lectura; exige instalar y mantener otro motor en un servidor cPanel sin Docker.
- **SQLite**: un archivo por instancia y backups triviales; el "solo lectura" dependería de la aplicación, no del motor.
- **MariaDB** (ya instalada): `GRANT SELECT` real a nivel de motor y `max_statement_time`; JSON más limitado que JSONB.

## Decisión
MariaDB. La consulta libre de Claude usa un usuario que **solo puede leer vistas** de datos financieros (nunca tablas de autenticación, tokens ni la bitácora en bruto), con límite de tiempo por consulta. Como cPanel concede privilegios por base completa y sus usuarios no pueden otorgar permisos por objeto, las vistas viven en una **base aparte de solo lectura** (`SQL SECURITY DEFINER`, creadas por el usuario de migración) y el usuario de lectura solo tiene `SELECT` sobre esa base. La aplicación y las migraciones usan usuarios distintos. Desarrollo y pruebas usan la misma versión mayor que producción.

## Consecuencias
- Cero infraestructura nueva; cPanel gestiona el motor y sus copias.
- La barrera de solo lectura la impone el motor, no el código.
- Los campos personalizados en JSON se validan en la aplicación; si hace falta indexarlos, columnas generadas.
- MariaDB 10.6 dejó de recibir mantenimiento regular: el código debe funcionar en 10.6 y 10.11+ para poder actualizar el servidor sin cambios.
