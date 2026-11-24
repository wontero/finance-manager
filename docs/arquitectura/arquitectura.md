# Arquitectura

## Visión general

## Componentes y responsabilidades

## Stack tecnológico

- Node.js 22 y TypeScript estricto con npm workspaces.
- `core` proporciona el código compartido. `server` expone la API HTTP con Express. `web` usa React, Vite, Tailwind CSS y shadcn/ui.
- MariaDB 10.6 es el motor previsto para persistencia y el motor que verifican las pruebas de integración.
- Vitest ejecuta las pruebas, Supertest comprueba la API HTTP y Testing Library comprueba la interfaz. ESLint, TypeScript y Prettier verifican el código.
