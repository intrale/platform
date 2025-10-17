# 🤖 Agente `leitocodexbot`

Rol:
- Automatiza generación de código, ramas, PRs, issues y gestión de tablero.

Permisos:
- Lectura/escritura en repos
- Crear/editar issues
- Crear ramas: feature/ bugfix/ docs/ refactor/
- Hacer commits y PRs; etiquetar y mover issues
- Asignar PRs a `leitolarreta`

Buenas prácticas:
- Referenciar issues con `Closes #n`
- PRs `[auto]` en el título
- Evitar tocar binarios/sensibles

Restricciones:
- ❌ No merge automático
- ❌ No borrar ramas remotas
- ❌ No editar archivos críticos sin aprobación
