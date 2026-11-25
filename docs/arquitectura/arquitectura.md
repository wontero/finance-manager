# Arquitectura

## Visión general

## Componentes y responsabilidades

## Stack tecnológico

- Node.js 22 y TypeScript estricto con npm workspaces.
- `core` proporciona el código compartido. `server` expone la API HTTP con Express. `web` usa React, Vite, Tailwind CSS y shadcn/ui.
- MariaDB 10.6 almacena los datos en tablas InnoDB con `utf8mb4`. El servidor usa Kysely sobre un pool de `mysql2`.
- Cada pool abre hasta 5 conexiones y admite hasta 64 solicitudes en espera. Cada conexión inicia con `STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION,ERROR_FOR_DIVISION_BY_ZERO` y zona horaria UTC. `/health` comparte y conserva el resultado de su comprobación durante 10 segundos. Su plazo total es de 1,5 segundos, incluso cuando espera una conexión.
- Vitest ejecuta las pruebas, Supertest comprueba la API HTTP y Testing Library comprueba la interfaz. ESLint, TypeScript y Prettier verifican el código.

## Datos contables

`accounts` guarda el árbol de cuentas y categorías. Las categorías son cuentas de ingreso y gasto. Una cuenta de activo o pasivo tiene moneda fija, mientras que las de ingreso, gasto y patrimonio admiten líneas en varias monedas. Los activos pueden ser `banco`, `efectivo`, `ahorro`, `inversion` o `por_cobrar`. Los pasivos pueden ser `tarjeta_credito` o `prestamo_recibido`. `currencies` define las unidades mínimas. Solo se exige un nombre único entre hermanos activos, incluidas las raíces.

`transactions` guarda el asiento y su fecha contable sin hora. Las marcas de tiempo del esquema usan `DATETIME(3)` en UTC. `postings` registra las líneas con signo en unidades mínimas. El dominio comprobará que cada asiento cuadra por moneda y usará la cuenta de patrimonio Cambio de moneda para transferencias entre monedas. `exchange_rates` guarda tipos entre monedas distintas por fecha, par y fuente. Una unidad de `from_currency` equivale a `rate` unidades de `to_currency`. El driver devuelve `BIGINT` y `DECIMAL(24,10)` como cadenas. Para operar con unidades mínimas se convierte explícitamente con `BigInt(valor)`. El tipo de cambio se conserva como cadena decimal para operaciones exactas posteriores.

`transaction_tags` relaciona asientos y etiquetas. `custom_field_definitions` define los campos almacenados como JSON en cuentas y asientos. `operations` agrupa los cambios y permite un único deshacer directo por operación. Usa `ORDER BY seq` para obtener el orden de asignación del autoincremento, incluso dentro del mismo milisegundo. Puede haber saltos y el orden de confirmación de transacciones concurrentes puede diferir. `audit_log` conserva el antes y el después de cada cambio, con un índice por tabla e ID de fila. Los triggers rechazan `UPDATE` y `DELETE` de la bitácora. La cuenta administrativa de migración conserva los permisos DDL necesarios para restaurar el esquema.

## Consultas y migraciones

La base de consulta contiene vistas `SQL SECURITY DEFINER` con columnas explícitas y `ALGORITHM=TEMPTABLE`, que impide actualizarlas. Así quedan fuera la bitácora y los objetos que se agreguen a la base principal. `v_accounts` incluye las cuentas archivadas con `archived_at`. `v_transactions`, `v_postings` y `v_transaction_tags` excluyen asientos borrados lógicamente. `v_postings` conserva el nombre y tipo de la cuenta e incluye la fecha contable del asiento. `v_custom_field_definitions` muestra solo las definiciones activas. Los valores JSON `custom` se reservan para la aplicación, lo que evita devolver valores de campos archivados.

Las migraciones TypeScript viven en `src/server/migrations`. Se aplican hacia adelante en orden `AAAAMMDDHHMM_descripcion`. `npm run migrate` comprueba los permisos de triggers antes de inicializar Kysely. Después de aplicar las migraciones, recrea las vistas con el usuario de migración y elimina las vistas obsoletas cuyo nombre empieza por `v_`. El DDL de MariaDB puede dejar cambios parciales si falla una migración. El despliegue toma un volcado previo para recuperar la base principal.
