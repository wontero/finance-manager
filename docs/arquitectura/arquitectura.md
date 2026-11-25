# Arquitectura

## Visión general

## Componentes y responsabilidades

## Stack tecnológico

- Node.js 22 y TypeScript estricto con npm workspaces.
- `core` proporciona el código compartido. `server` expone la API HTTP con Express. `web` usa React, Vite, Tailwind CSS y shadcn/ui.
- MariaDB 10.6 almacena los datos en tablas InnoDB con `utf8mb4`. El servidor usa Kysely sobre un pool de `mysql2`.
- Vitest ejecuta las pruebas, Supertest comprueba la API HTTP y Testing Library comprueba la interfaz. ESLint, TypeScript y Prettier verifican el código.

## Datos contables

`accounts` guarda el árbol de cuentas y categorías. Las categorías son cuentas de ingreso y gasto. Una cuenta de activo o pasivo tiene moneda fija, mientras que las de ingreso, gasto y patrimonio admiten líneas en varias monedas. `currencies` define las unidades mínimas. Solo se exige un nombre único entre hermanos activos, incluidas las raíces.

`transactions` guarda el asiento y su fecha contable sin hora. `postings` registra las líneas con signo en unidades mínimas. El dominio comprobará que cada asiento cuadra por moneda y usará la cuenta de patrimonio Cambio de moneda para transferencias entre monedas. `exchange_rates` guarda tipos por fecha, par de monedas y fuente. El driver devuelve `BIGINT` y `DECIMAL(24,10)` como cadenas. Para operar con unidades mínimas se convierte explícitamente con `BigInt(valor)`. El tipo de cambio se conserva como cadena decimal para operaciones exactas posteriores.

`transaction_tags` relaciona asientos y etiquetas. `custom_field_definitions` define los campos almacenados como JSON en cuentas y asientos. `operations` agrupa los cambios y puede referenciar una operación deshecha. `audit_log` conserva el antes y el después de cada cambio. Los triggers rechazan `UPDATE` y `DELETE` de la bitácora. La cuenta administrativa de migración conserva los permisos DDL necesarios para restaurar el esquema.

## Consultas y migraciones

La base de consulta contiene vistas `SQL SECURITY DEFINER` con columnas explícitas. Así quedan fuera la bitácora y los objetos que se agreguen a la base principal. `v_accounts` oculta cuentas archivadas. `v_transactions` y `v_postings` excluyen asientos borrados lógicamente. `v_postings` conserva los nombres de cuentas archivadas en asientos vigentes para preservar su historia. `v_custom_field_definitions` muestra solo las definiciones activas. Los valores JSON `custom` se reservan para la aplicación, lo que evita devolver valores de campos archivados.

Las migraciones TypeScript viven en `src/server/migrations`. Se aplican hacia adelante en orden `AAAAMMDDHHMM_descripcion`. `npm run migrate` comprueba el historial de Kysely y recrea las vistas con el usuario de migración. El DDL de MariaDB puede dejar cambios parciales si falla una migración. El despliegue toma un volcado previo para recuperar la base principal.
