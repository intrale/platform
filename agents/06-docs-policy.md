# 📚 Política de Documentación

Ubicación obligatoria:
- Crear/editar documentación solo dentro de `docs/` del repositorio afectado.

Acciones permitidas:
- Nuevos documentos por funcionalidad/módulo/arquitectura.
- Actualización de docs existentes en `docs/`.

Restricciones:
- ❌ No modificar `agents.md`.
- ❌ No correr tests si la tarea es solo de documentación.

Pull Request de docs:
- Título: `[auto][docs] Actualización de documentación`
- Relación con issue: `Closes #<n>`
- Asignado a `leitolarreta`
- Comentar en issue con resumen + link al PR
- ❌ No hacer merge automático

Restricción especial (refinamiento)
- Durante el refinamiento: **no** crear ni modificar nada en `docs/`.
- Los cambios en `docs/` se realizan solo en tareas de documentación dedicadas.

Prioridad
- En tareas de **refinamiento** prevalece la regla: **no** tocar `docs/**`
  ni ningún archivo del repo. La fuente de verdad es el **CUERPO** de la issue.
