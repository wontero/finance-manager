# FinanceManager

Finanzas personales con Claude como interfaz conversacional, respaldadas por un libro contable auditable.

## Qué resuelve

FinanceManager registra ingresos, gastos, transferencias, préstamos y saldos en varias monedas. Claude.ai se conecta como interfaz principal mediante MCP remoto y OAuth; la aplicación no incluye IA ni llama a una API de IA, así que no añade coste de API.

## Demostración

Conversación ficticia; los importes y personas son de ejemplo:

> **Tú:** Registra 45,50 BOB de almuerzo desde Efectivo, en Gastos › Comida.
>
> **Claude:** Registré el gasto. Efectivo queda en 454,50 BOB. Operación: `op-ejemplo-01`.
>
> **Tú:** Transfiere 100 USD a mi cuenta en BOB; recibí 696 BOB.
>
> **Claude:** Registré ambos importes y la conversión. Operación: `op-ejemplo-02`.
>
> **Tú:** Presté 1.000 BOB a Ana el 1 de enero de 2024 al 2 % mensual. ¿Cuánto debe al 31 de enero?
>
> **Claude:** El interés simple acumulado es 19,73 BOB; el saldo total es 1.019,73 BOB.
>
> **Tú:** Deshaz el gasto del almuerzo.
>
> **Claude:** Gasto revertido. La transferencia y el préstamo siguen registrados.

## Incremento 1

- Libro de partida doble con cuentas, categorías, etiquetas y campos personalizados.
- Gastos, ingresos, transferencias multimoneda, carga por lotes, conciliación y valuación patrimonial.
- Préstamos hechos y recibidos con interés simple y abonos aplicados primero a intereses.
- Herramientas MCP para registrar, consultar y deshacer operaciones; consulta SQL limitada a vistas financieras de solo lectura.
- Autenticación OAuth 2.1 con contraseña y TOTP.
- Copias cifradas y guías de despliegue y recuperación.

## Arquitectura

```mermaid
flowchart LR
    C[Claude.ai] -->|OAuth 2.1 + MCP| M[/mcp]
    M --> L[ledger]
    L --> D[(MariaDB principal)]
    L --> R[(MariaDB _ro: vistas de lectura)]
```

## Decisiones técnicas

- Importes enteros en unidades menores y partida doble: [ADR 0003](docs/adr/0003-partida-doble-y-dinero.md).
- Bitácora append-only, borrado lógico y operaciones reversibles: [ADR 0006](docs/adr/0006-auditoria-y-deshacer.md).
- Consultas sobre una base separada `_ro` con vistas y usuario lector: [ADR 0002](docs/adr/0002-mariadb.md).
- OAuth 2.1 y Claude mediante MCP: [ADR 0004](docs/adr/0004-claude-via-mcp.md).
- Monolito modular TypeScript: [ADR 0001](docs/adr/0001-monolito-modular-typescript.md).
- Extensiones controladas por metadatos: [ADR 0005](docs/adr/0005-extensibilidad-controlada.md).
- cPanel y Passenger para el despliegue: [ADR 0007](docs/adr/0007-despliegue-cpanel-passenger.md).

## Calidad

La última ejecución documentada en M-008B reportó **46 pruebas unitarias/HTTP, 115 de integración y tres suites Bash**; también pasaron build, lint, typecheck y formato. La integración usó MariaDB 10.6.28. Comandos: `npm test`, `npm run test:integration`, `bash src/deploy/deploy.test.sh`, `bash src/deploy/backup.test.sh` y `bash src/deploy/guide.test.sh`.

## Puesta en marcha local

Requiere Node.js 22 y MariaDB 10.6. [Configura el entorno local](README.md#configuración) y luego ejecuta:

```powershell
npm ci
npm run db:start
npm run db:setup
npm run dev
```

El README incluye los pasos para preparar MariaDB aislada y configurar `.env`.

## Despliegue

Consulta la [guía de despliegue](docs/operacion/despliegue.md) para cPanel/Passenger, OAuth, copias y recuperación.

## Hoja de ruta

El incremento 2 incorpora el dashboard. Después están previstos presupuestos, movimientos recurrentes y objetivos financieros.

## Licencia

Pendiente.

## English summary

FinanceManager is a personal finance ledger controlled through Claude.ai over remote MCP and OAuth. It supports double-entry, multiple currencies, reversible operations, simple-interest loans, and encrypted backups. The dashboard is planned for increment 2.

