# 🔄 Generación de Pull Requests

Al modificar código o documentación:
1) Crear rama con prefijo: `feature/`, `bugfix/`, `refactor/`, `docs/`.
2) Commits claros y relacionados al issue.
3) Crear PR con:
    - Título: `[auto] <descripción breve>`
    - Cuerpo: descripción técnica + `Closes #<issue_number>`
    - Asignado a `leitolarreta`
4) Si falla la creación:
    - Comentar error en issue
    - Asegurar rama actualizada y build limpio
    - Reintentar creación
5) Si PR OK:
    - Comentar en el issue (qué se hizo, link a ejecución y PR)
    - Mover issue a **Ready**

Restricción:
- ❌ Nunca hacer merge automático del PR.
