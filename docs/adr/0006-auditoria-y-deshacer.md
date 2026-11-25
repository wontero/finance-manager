# ADR-0006 — Bitácora de auditoría y deshacer por operación

## Estado
Aceptada (2026-11-24).

## Contexto
Claude opera con mucha autonomía (incluida la carga masiva de historial leído de capturas de pantalla, propensa a errores). Debe ser posible ver qué hizo, quién lo hizo y revertirlo.

## Opciones consideradas
- **Solo backups**: revertir implica restaurar todo y perder cambios posteriores.
- **Event sourcing**: el estado se deriva de eventos. Potente, pero mucho más complejo.
- **Bitácora append-only + borrado lógico + deshacer por operación.**

## Decisión
- Cada cambio se registra en una bitácora que solo admite inserciones: actor (`claude` / `web`), fecha, valores antes y después, y un **ID de operación** que agrupa todo lo que provocó un mismo pedido (por ejemplo, un lote de 30 movimientos).
- Los registros no se borran físicamente desde Claude: borrado lógico.
- "Deshacer operación X" genera los cambios inversos, que también quedan auditados. Devuelve cada fila tocada a su estado anterior (una fila creada por X se elimina; su contenido sigue en la bitácora y deshacer el deshacer la repone) y solo procede si nadie cambió esas filas después; si no, avisa qué operación posterior lo impide.

## Consecuencias
- Un lote mal leído se revierte entero con una orden.
- El dashboard puede mostrar la actividad de Claude con un botón de deshacer.
- Las consultas habituales filtran los registros borrados lógicamente; la bitácora crece sin límite (aceptable para un solo usuario).
