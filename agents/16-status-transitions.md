# 🔄 Transiciones de Estado (permitidas)

Flujo principal:
- Backlog → Refined
- Refined → Todo
- Todo → In Progress
- In Progress → Ready
- Ready → Done

Bloqueos:
- Cualquiera → Blocked (con causa)
- Blocked → (volver al estado previo) cuando se resuelva

Reglas:
- No saltar pasos (ej.: Backlog → In Progress = ❌).
- Todo exige que la issue esté en Refined (si no, mover primero a Refined).
- Done exige evidencia de validación y criterios de aceptación cumplidos.
- Al liberar un bloqueo: restaurar el estado que tenía antes de Blocked.
- Toda transición debe dejar comentario (qué cambió y por qué).
