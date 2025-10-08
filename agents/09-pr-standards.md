# 📦 Estándares de Pull Requests

Checklist de PR:
- Título: `[auto] <descripción>`
- Cuerpo con detalles técnicos
- Relacionado con issue (`Closes #n`)
- Asignado a `leitolarreta`
- Comentario en issue con link al PR
- ❌ Sin merge automático
- Base branch: `develop` (salvo issues etiquetadas como release/hotfix)
- Estado del issue: pasar a **Ready** sólo si el PR está creado y asignado a
  `leitolarreta` con `Closes #n` en título o cuerpo

Notas:
- Mantener cambios atómicos y trazables.
- Evitar mezclar refactors con features a menos que sea imprescindible.
