# ADR-0005 — Extensibilidad controlada (sin DDL por parte de Claude)

## Estado
Aceptada (2026-11-24).

## Contexto
Se quiere que el sistema evolucione conversando con Claude (nuevas categorías, campos, tipos de registro) sin programar cada necesidad, manteniendo integridad, seguridad y trazabilidad.

## Opciones consideradas
- **DDL libre**: Claude crea tablas y columnas. Máxima flexibilidad; rompe la integridad, complica migraciones y backups, y una instrucción errónea puede corromper el esquema.
- **Esquema núcleo fijo + metadatos**: campos personalizados, etiquetas y tipos de registro definidos por esquema, siempre validados y auditados.
- Lo anterior **+ consulta SQL de solo lectura** para análisis libres.

## Decisión
Esquema núcleo fijo + metadatos + SQL de solo lectura (ver ADR-0002). Claude nunca ejecuta DDL. Los comportamientos de tipos nuevos se eligen de un catálogo cerrado (por ejemplo, "afecta saldos", "es recurrente"), nunca código arbitrario.

Por incrementos: primero etiquetas, campos personalizados simples (texto, número, fecha, opción) y SQL de solo lectura; los tipos de registro personalizados llegan cuando haya necesidades reales que los guíen.

## Consecuencias
- Claude adapta el sistema a casi cualquier necesidad sin poder romper su estructura.
- Lo que no quepa en el modelo se convierte en trabajo de desarrollo explícito, revisado y probado.
