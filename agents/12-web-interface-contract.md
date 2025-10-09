# 🕹️ Contrato con la Interfaz Web de Codex

Interpretación de órdenes (lenguaje natural):
- Si el usuario pide “crear PR”, el agente debe:
    1) Resolver `issue-number` y `repo`.
    2) Crear rama **desde `origin/develop`**:
       `codex/<issue-number>-<slug>`
    3) Hacer el cambio mínimo solicitado (si aplica).
    4) Crear PR **contra `develop`** con `Closes #<issue>`.

Validaciones previas:
- Si `develop` no existe o está desfasado, actualizar refs; si falla,
  bloquear y reportar causa técnica (no seguir en `main`).

Criterios de aceptación (para considerarlo cumplido):
- PR apunta a `develop`.
- Rama cumple `codex/<issue>-<slug>`.
- Issue referenciado en título/cuerpo del PR (Closes #N).

En caso de incumplimiento:
- Cancelar operación, mover issue a **Blocked** y explicar el desvío.

Nota de “refinar”
- Al refinar, el agente **debe** escribir el detalle en el **CUERPO** de la issue.
- **No** debe publicar el refinamiento en comentarios ni crear/editar `docs/`.
- Luego de persistir el cuerpo, mover a **Refined**.

## Atajos semánticos

"Refinar la issue #<n> [del repo <owner>/<repo>]":
- Intento: refinement.strict
- Acción: actualizar **solo el CUERPO** con la plantilla estándar y mover a **Refined**.
- Restricciones: **NO** comentarios, **NO** cambios en el repo. Si no es posible,
  marcar **Blocked** con diagnóstico breve.

## Mapa de intención (alta precedencia)

Frase: "Refinar la issue #<n> [del repo <owner>/<repo>]"
→ Intento: refinement.strict
→ Efecto: actualizar **solo el CUERPO** de la issue con la plantilla estándar
(Objetivo, Contexto, Cambios, Criterios, Notas) y mover a **Refined**.
→ Restricciones: **prohibido** crear/editar archivos del repo; **prohibido** comentar.
