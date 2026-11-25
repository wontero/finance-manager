# ADR-0007 — Despliegue en cPanel con Passenger y releases versionadas

## Estado
Aceptada (2026-11-24). Pendiente de validar en producción con el spike M-002.

## Contexto
El sistema se hospeda en un VPS propio con cPanel/WHM, sin Docker y sin sudo para la cuenta de usuario, que además aloja otros sitios en producción. Presupuesto de costes recurrentes: 0.

## Opciones consideradas
- **Contenedores** (Docker/Podman): no disponibles de forma fiable en este cPanel sin root.
- **Node en el espacio del usuario + proxy en `.htaccess` + cron** para reiniciar: frágil.
- **cPanel Application Manager (Phusion Passenger)** con Node.js 22 instalado desde EasyApache 4.

## Decisión
- Passenger ejecuta la aplicación detrás de Apache; Apache aporta HTTPS gratuito (AutoSSL).
- Subdominio propio por instancia; dashboard en `/`, MCP en `/mcp`.
- Despliegue con un script `deploy.sh` que ejecuta el propietario: releases fechadas, enlace `current` atómico, backup de la base antes de migrar, health check y vuelta automática a la release anterior si falla, `--rollback` manual, y conservación de las 5 últimas releases.
- El código se descarga de GitHub con una deploy key de solo lectura; los secretos viven solo en el servidor.

## Consecuencias
- Sin servicios nuevos que administrar; Passenger arranca, vigila y reinicia la aplicación.
- Un despliegue fallido no deja el sitio caído ni afecta a los demás sitios del servidor.
- Las respuestas MCP no usan streaming para evitar el buffering de Apache/Passenger (ver ADR-0004).
- Una instancia nueva (otra persona) es otro subdominio, otra base y otro directorio, sin cambios de código.
