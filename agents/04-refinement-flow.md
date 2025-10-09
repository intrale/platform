# 🔄 Flujo de Refinamiento (estricto)

Definición
- Refinar = escribir detalle en el **CUERPO** de la issue.

Secuencia
1) Verificar repo/issue y presencia en Project V2.
2) Actualizar el **CUERPO** con la plantilla (Objetivo, Contexto, Cambios,
   Criterios, Notas). Sin comentarios.
3) Mover estado a **Refined**.

Restricciones (duras)
- **PROHIBIDO** crear/editar archivos del repo (incluye `docs/**`).
- **PROHIBIDO** usar comentarios para volcar el refinamiento.

Post-condiciones
- Diffs del repo = **0 archivos** modificados.
- La issue muestra la plantilla completa en el CUERPO.
- Si no se pudo editar el cuerpo → marcar **Blocked** con diagnóstico breve.
