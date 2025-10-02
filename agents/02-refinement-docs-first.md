<!-- GENERATED: 2025-10-02T21:44:04Z -->
# 02 — Refinamiento (Modo único **Docs-first**)

Este complemento **no reemplaza** al archivo base; lo **extiende**. Mantiene todo lo anterior y agrega el nuevo comportamiento acordado para “refinar …”.

## Resumen
- Durante **refinamiento** el bot:
  - **Lee** el issue (número, título, repo) y **actualiza** su estado en Project v2 (→ *In Progress* y al finalizar *Todo* o *Ready*).
  - **No** modifica el cuerpo del issue ni deja comentarios.
  - **Genera** un archivo Markdown por issue en `docs/refinements/issue-<n>-<slug>.md` con la plantilla estándar.
  - Si `REFINE_DOCS_OPEN_PR=1` (**default**), abre un **PR de docs** para ese archivo. *Sin merge automático*.

## Intenciones de lenguaje natural
- “**refinar …**” → ejecuta `scripts/refine_all.sh` (**Docs-first**).
- “**trabajar …**” → ejecuta `scripts/work_all.sh` (opcional PR de código).

## Auto-discover (Project v2)
Si faltan IDs (`STATUS_FIELD_ID`, `STATUS_OPTION_*`), el router ejecuta `discover` automáticamente, genera `.codex_env` y lo carga antes de despachar.

## Estados y finalización
1. **In Progress** al comenzar.
2. **Todo** por defecto al finalizar (si existe `STATUS_OPTION_READY`, puede usarse **Ready** como estado final).

## Plantilla del snapshot
Ruta: `docs/refinements/issue-<n>-<slug>.md`

```md
## Objetivo
(Completar con el objetivo concreto de la tarea)

## Contexto
(Estado actual / antecedentes. Referencias de rutas del repo.)

## Cambios requeridos
- Ruta/componente 1: /workspace/...
- Ruta/componente 2: /workspace/...
- Pruebas esperadas
- Documentación a actualizar en /docs si aplica

## Criterios de aceptación
- [ ] Criterio 1 verificable
- [ ] Criterio 2 verificable

## Notas técnicas
(Decisiones, riesgos, toggles, migraciones)
```

## Guardas de escritura (solo refinamiento)
- **Permitido escribir únicamente en** `docs/refinements/**`.
- Cualquier intento de escribir fuera de ese path debe **abortar**, **revertir** cambios y dejar evidencia (vía log/estado).

## Variables y *defaults*
- `REFINE_WRITE_DOCS=1`  *(Docs-first, siempre ON)*
- `REFINE_DOCS_OPEN_PR=1` *(PR de docs automático)*
- `BATCH_MAX=10`          *(lote por corrida)*

## “Trabajar …”
Se mantiene el comportamiento actual (posibilidad de PR de código si `WORK_OPEN_PR=1`). No interfiere con el flujo Docs-first.
