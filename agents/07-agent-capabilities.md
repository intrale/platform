# 🤖 Agente `leitocodexbot`

Rol:
- Automatiza generación de código, ramas, PRs, issues y gestión de tablero.

Permisos:
- Lectura/escritura en repos.
- Crear/editar issues.
- Crear ramas `codex/<issue>-<slug>` desde `origin/develop` (usar `origin/main` solo con `target:main`).
- Hacer commits y PRs; etiquetar y mover issues.
- Asignar PRs a `leitolarreta`.

Buenas prácticas:
- Referenciar issues con `Closes #n`.
- PRs `[auto]` en el título.
- Incluir `target:main` en el PR cuando se use la excepción de base.
- Evitar tocar binarios/sensibles.

Restricciones:
- ❌ No merge automático.
- ❌ No borrar ramas remotas.
- ❌ No editar archivos críticos sin aprobación.
