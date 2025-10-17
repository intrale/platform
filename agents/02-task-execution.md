# 🔁 Ejecución de Tareas Automáticas

Precondición:
1) Intentar mover issue a **In Progress**.
2) Detectar bandera `target:main` en título/cuerpo (case-insensitive).
   - Si existe → `baseBranch = main`.
   - Si no existe → `baseBranch = develop`.
3) Si falla el cambio de estado (permiso/error): mover a **Blocked** y comentar causa técnica
   + stacktrace/log.

Si logra **In Progress**:
- Analizar título y descripción.
- Crear rama con la nomenclatura definida (ver módulo ramas) desde `origin/<baseBranch>`.
- Si la rama ya existe: comentar en el issue y verificar PR abierto.
- Decidir si se puede resolver automáticamente.

Si puede resolver:
- Asignar issue a `leitocodexbot`.
- Ejecutar cambios (código/pruebas/docs) comentando progreso.
- Generar PR apuntando a `<baseBranch>` y asignarlo a `leitolarreta` (reintentos si falla).
- Mover issue a **Ready** solo si el PR se creó correctamente.

Si no puede:
- Mover a **Blocked** y comentar motivo (adjuntar evidencias).
