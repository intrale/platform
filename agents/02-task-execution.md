# 🔁 Ejecución de Tareas Automáticas

Precondición:
1) Asegurar que la issue esté añadida al Project V2 (agregar si falta).
2) Validar que el estado actual respete las transiciones permitidas.
3) Intentar mover issue a **In Progress**.
4) Si falla (permiso/error): mover a **Blocked** y comentar causa técnica
   + stacktrace/log.

Si logra **In Progress**:
- Analizar título y descripción.
- Crear rama con la nomenclatura definida (ver módulo ramas).
- Si la rama ya existe: comentar en el issue y verificar PR abierto.
- Decidir si se puede resolver automáticamente.

Si puede resolver:
- Asignar issue a `leitocodexbot`.
- Ejecutar cambios (código/pruebas/docs) comentando progreso.
- Generar PR y asignarlo a `leitolarreta` (reintentos si falla).
- Mover a **Ready** solo si el PR se creó correctamente.

Si no puede:
- Mover a **Blocked** y comentar motivo (adjuntar evidencias).
