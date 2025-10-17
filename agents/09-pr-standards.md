# 📦 Estándares de Pull Requests

Checklist de PR:
- Base: `develop` (usar `main` solo si el issue/PR declara `target:main`).
- Título: `[auto] <descripción>`.
- Cuerpo con detalles técnicos + `Closes #n`.
- Relacionado con issue (`Closes #n`).
- Asignado a `leitolarreta`.
- Comentario en issue con link al PR.
- ❌ Sin merge automático.
- Plantilla disponible en [`17-pr-template.md`](./17-pr-template.md).

Notas:
- Mantener cambios atómicos y trazables.
- Evitar mezclar refactors con features a menos que sea imprescindible.
- Si se usa la excepción `target:main`, documentar la razón en el PR y en el issue.
