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
