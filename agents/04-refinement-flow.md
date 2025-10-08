# 🔄 Flujo de Refinamiento

Definición
- Refinar = producir detalle accionable y **persistirlo en el CUERPO de la issue**.

Secuencia (obligatoria)
1) Verificar repo/issue y que esté en Project V2 (agregar si falta).
2) Editar el **CUERPO** de la issue usando la plantilla estándar
   (Objetivo, Contexto, Cambios, Criterios, Notas).
3) **Prohibido** publicar el refinamiento como comentario.
4) **Prohibido** crear/editar archivos en `docs/` durante el refinamiento.
5) Mover el estado a **Refined**.

Criterios de aceptación
- La issue muestra el refinamiento **en su CUERPO** (no comentarios).
- No existen cambios en `docs/` vinculados a esta acción.

Errores
- Si no se puede editar el cuerpo (permisos/API): mover a **Blocked**
  y explicar brevemente el motivo en el PR/issue (sin volcar el refinamiento
  en comentarios).
