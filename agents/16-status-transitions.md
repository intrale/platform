# 🔁 Transiciones válidas de estado (Project V2)

Backlog → Refined → Todo → In Progress → Ready → Done

- `Blocked` puede aplicarse en cualquier estado.
- Las transiciones deben mantener trazabilidad (comentario automático al cambiar estado).
- El paso a `In Progress` ocurre **al tomar el issue** de Todo (no al crear el PR),
  consistente con `01-board-management.md` y `02-task-execution.md`.
- Cambios automáticos provocados por PRs:
    - Al crear PR asociado: `In Progress → Ready`.
    - Al mergear PR: mover a `Done` **cuando** cumpla criterios QA.

> **Semántica:** transiciones del **tablero declarativo** Projects V2. El estado
> operativo real del pipeline V3 son carpetas en el filesystem (Pulpo).
