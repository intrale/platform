# 🌱 Nomenclatura de Ramas (obligatoria)

Base por defecto:
- **Toda rama nueva debe crearse desde `origin/develop`.**
- Excepción: `target:main` → base `origin/main`.

Formato de nombre (una rama por issue):
- `codex/<issue-number>-<slug-kebab>`
  - `<issue-number>`: número del issue (obligatorio).
  - `<slug-kebab>`: título en minúsculas con guiones.

Ejemplos:
- `codex/123-agregar-badges-ci`
- `codex/457-fix-nullpointer-en-login`

Subtareas:
- Si el issue es sub-tarea, usar **la misma rama** del issue padre
  (no crear ramas extra).

Reglas rápidas:
- ❌ No usar `feature/`, `bugfix/`, etc. para trabajos de Codex.
- ✅ Una rama por issue, commits atómicos.
- ✅ Reutilizar rama solo si es el mismo issue.
