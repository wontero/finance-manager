# ADR-0003 — Partida doble, dinero en enteros y multimoneda

## Estado
Aceptada (2026-11-24).

## Contexto
El sistema registra cuentas de banco, efectivo, ahorro, inversión, tarjetas, préstamos dados y recibidos, en bolivianos (BOB) y dólares (USD). Debe mostrar saldos, patrimonio y deudas que siempre cuadren, aunque los registros los cree una IA.

## Opciones consideradas
- **Movimientos simples con tipo** (ingreso, gasto, transferencia): sencillo al principio; deudas, multimoneda y conciliaciones se vuelven casos especiales.
- **Partida doble**: cada operación es un asiento cuyas líneas suman cero.
- **Montos en coma flotante** frente a **enteros en la unidad mínima** (centavos).

## Decisión
- **Partida doble interna**, oculta tras una API simple: "gasté 45 Bs en almuerzo" genera Efectivo −45 / Gastos:Comida +45. Préstamos y deudas son cuentas por cobrar/pagar.
- **Montos como enteros en centavos**; nunca coma flotante.
- **Una moneda por cuenta.** Una operación entre monedas guarda **los dos montos reales**, por lo que el tipo de cambio de cada operación nunca se inventa.
- **Moneda base de reportes: BOB.** Para valuar se usa una tabla de tipos de cambio con fecha y fuente (tipo referencial publicado por el banco central, registrado por Claude a demanda); una fecha sin tipo usa el último anterior. El sistema no llama a APIs externas.

## Consecuencias
- Por construcción, el sistema no puede descuadrar: patrimonio, deudas y transferencias cierran siempre.
- Préstamos con interés, deudas y conciliaciones encajan sin casos especiales.
- Los reportes en BOB dependen de que los tipos de cambio estén registrados; los saldos por cuenta nunca dependen de ellos.
