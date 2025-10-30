# 🔁 Transiciones válidas de estado (Project V2)

Backlog → Refined → Todo → In Progress → Ready → Done

- `Blocked` puede aplicarse en cualquier estado.
- Las transiciones deben mantener trazabilidad (comentario automático al cambiar estado).
- Cambios automáticos provocados por PRs:
    - Al crear PR asociado: `Todo → In Progress` (si aplica tu flujo).
    - Al mergear PR: mover a `Done` **cuando** cumpla criterios QA.