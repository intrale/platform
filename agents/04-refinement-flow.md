# 🔄 Flujo de Refinamiento (única fuente)

Definición
- Refinar = escribir detalle accionable en el **CUERPO** de la issue.

Secuencia
1) Verificar repo/issue y que esté en Project V2 (agregar si falta).
2) Sobrescribir el **CUERPO** con la plantilla estándar:
   Objetivo, Contexto, Cambios, Criterios, Notas técnicas.
3) Mover el estado a **Refined**.

Restricciones
- ❌ No comentarios para volcar el refinamiento.
- ❌ No crear/editar archivos del repo (incluye `docs/**`).

Condición de corte
- Si no se puede editar el cuerpo → **Blocked** con diagnóstico breve.
- Diffs del repo esperados: **0 archivos** modificados.
