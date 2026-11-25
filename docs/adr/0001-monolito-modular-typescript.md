# ADR-0001 — Monolito modular en TypeScript

## Estado
Aceptada (2026-11-24).

## Contexto
Finance Manager tiene tres caras: un servidor MCP para que Claude gestione las finanzas conversando, una API para el dashboard y el dashboard web. Lo mantiene una sola persona, que no escribe el código a mano (lo implementan agentes), y se hospeda en un VPS con cPanel sin coste extra.

## Opciones consideradas
- **TypeScript de punta a punta**: el SDK oficial de MCP más maduro está en TypeScript; backend, MCP y frontend comparten tipos y validaciones.
- **Python (FastMCP + FastAPI) + frontend en TypeScript**: dos lenguajes y validaciones duplicadas.
- **C#/.NET**: SDK de MCP disponible, pero el frontend seguiría siendo TypeScript.
- **Microservicios** (MCP, API y web separados) frente a **un monolito modular**.

## Decisión
Un único proceso Node.js 22 en TypeScript, organizado como monorepo con npm workspaces:
- `core`: reglas de dominio y validación (Zod). Es la única fuente de verdad de las reglas.
- `server`: Express; expone MCP, OAuth, API REST y sirve la web.
- `web`: React + Vite + Tailwind CSS + shadcn/ui.

## Consecuencias
- Una sola pieza que desplegar, vigilar y respaldar.
- Claude (vía MCP) y el dashboard usan exactamente las mismas reglas: no pueden comportarse distinto.
- Stack muy común: fácil de mantener por agentes y de entender por terceros.
- Si algún día una parte necesitara escalar por separado, los límites entre paquetes ya están marcados.
