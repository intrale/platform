# 🔁 Ejecución de Tareas Automáticas

Precondición:
1) Intentar mover issue a **In Progress** (al tomar de Todo; ver `16-status-transitions.md`).
2) Si falla (permiso/error): mover a **Blocked** y comentar causa técnica
    + stacktrace/log.

Si logra **In Progress**:
- Analizar título y descripción.
- Crear rama con la nomenclatura definida (ver módulo ramas).
- Si la rama ya existe: comentar en el issue y verificar PR abierto.
- Decidir si se puede resolver automáticamente.

Si puede resolver:
- Asignar issue a `leitocodexbot`.
- Ejecutar cambios (código/pruebas/docs) comentando progreso.
- Cumplir reglas de verificación y evidencia (ver módulo correspondiente).
- Generar PR y asignarlo a `leitolarreta` (reintentos si falla).
- Mover a **Ready** solo si el PR se creó correctamente.

Si no puede:
- Mover a **Blocked** y comentar motivo (adjuntar evidencias).
