# ADR-0004 — Claude como interfaz principal vía MCP remoto

## Estado
Aceptada (2026-11-24).

## Contexto
La interfaz principal es conversar con Claude desde la computadora y el celular, usando la suscripción existente y sin coste de API. Claude debe registrar, consultar, corregir y analizar con autonomía, pero sin poder causar daños irreversibles.

## Opciones consideradas
- **Integrar un modelo vía API** en la aplicación: coste por uso y una interfaz de chat propia que mantener.
- **Servidor MCP remoto** conectado como conector personalizado de Claude.ai (web y móvil).
- Para las herramientas: **CRUD genérico por tabla** frente a **herramientas de dominio**.

## Decisión
- Servidor **MCP remoto** dentro de la aplicación, en `/mcp`, con transporte Streamable HTTP **sin estado y con respuestas JSON** (compatible con Apache/Passenger, sin streaming).
- **Herramientas de dominio** (registrar uno o varios movimientos, consultar, resumir períodos, saldos, patrimonio, categorías, tipos de cambio, conciliación, deshacer, SQL de solo lectura), anotadas como de lectura o destructivas.
- **Autenticación OAuth 2.1** servida por la propia aplicación con librerías maduras; tokens revocables desde el dashboard. Usuario único con contraseña + TOTP.
- **Límites de autonomía**: Claude crea, edita y deshace; no borra de forma definitiva ni toca credenciales o seguridad (solo desde el dashboard).

## Consecuencias
- Coste cero de IA; Claude funciona igual en escritorio y móvil.
- Claude se equivoca menos con herramientas que hablan su idioma que con tablas.
- La aplicación debe ser accesible públicamente por HTTPS, lo que hace de OAuth la pieza de seguridad más crítica.
- Todo lo que Claude lee del sistema entra en su contexto: la auditoría y el deshacer (ADR-0006) son la red de seguridad.
