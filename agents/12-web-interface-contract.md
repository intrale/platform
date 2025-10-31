# 🕹️ Contrato con la Interfaz Web de Codex (Actualizado a `main`)

Interpretación de órdenes (lenguaje natural)

Si el usuario pide “crear PR”, el agente debe:
1) Resolver `issue-number` y `repo`.
2) Crear rama **desde `origin/main`** con el formato **`codex/<issue-number>-<slug>`**.
3) Hacer el cambio mínimo solicitado (si aplica).
4) Crear **PR contra `main`** con `Closes #<issue>`.

Validaciones previas
- Si `main` no existe localmente, hacer `git fetch --all --prune`. Si falla, **bloquear** y reportar causa técnica (no continuar en otra base).

Criterios de aceptación
- PR apunta a `main`.
- Rama cumple `codex/<issue>-<slug>`.
- Issue referenciado en título/cuerpo del PR (`Closes #N`).

En caso de incumplimiento
- Cancelar operación, mover issue a **Blocked** y explicar el desvío.

## Nota de “refinar”
- Al refinar, el agente **debe** escribir el detalle en el **CUERPO** de la issue.
- **No** debe publicar el refinamiento en comentarios ni crear/editar `docs/`.
- Luego de persistir el cuerpo, mover a **Refined**.

## Atajos semánticos

"Refinar la issue #<n> [del repo <owner>/<repo>]":
- Intento: `refinement.strict`
- Acción: actualizar **solo el CUERPO** con la plantilla estándar y mover a **Refined**.
- Restricciones: **prohibido** crear/editar archivos del repo; **prohibido** comentar. Si no es posible, marcar **Blocked** con diagnóstico breve.
