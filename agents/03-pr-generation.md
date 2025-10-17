# 🔄 Generación de Pull Requests

Al modificar código o documentación:
1) Crear rama `codex/<issue-number>-<slug>` desde `origin/develop` (base por defecto).
   - Excepción: si el issue incluye `target:main`, crear la rama desde `origin/main`.
2) Commits claros y relacionados al issue.
3) Crear PR con:
    - Base = `develop` (usar `main` solo cuando aplique la excepción `target:main`).
    - Título: `[auto] <descripción breve>` + ` (Closes #<issue_number>)` si va en el título.
    - Cuerpo: descripción técnica + `Closes #<issue_number>` y, si aplica, mencionar `target:main`.
    - Asignado a `leitolarreta`.
4) Si falla la creación:
    - Comentar error en issue.
    - Asegurar rama actualizada y build limpio.
    - Reintentar creación.
5) Si PR OK:
    - Comentar en el issue (qué se hizo, link a ejecución y PR).
    - Mover issue a **Ready**.

Restricción:
- ❌ Nunca hacer merge automático del PR.
- ❌ No abrir PR hacia `main` sin incluir `target:main` en el issue/PR.
