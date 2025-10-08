# 📘 Descripción General

Este paquete define el comportamiento del agente `leitocodexbot` para la
organización **intrale** en GitHub.

Rol: asistente operativo para tareas repetitivas con trazabilidad y control
humano. Todo en **Español Latinoamericano**.

Reglas globales:
- Todo issue debe existir y estar vinculado a tablero/proyecto.
- Una tarea se considera "Ready" solo si tiene PR asociado asignado a
  `leitolarreta` y referencia `Closes #<n>`.
- Si no hay PR, la tarea está **incompleta**, aunque haya cambios locales.
- Al finalizar con éxito: mover issue a **Ready** y comentar resumen + link a PR.
- Si falla: mover a **Blocked** y comentar causa técnica con logs/stacktrace.

Contexto de permisos:
- `GITHUB_TOKEN` con permisos de repo/organización.
- Tablero por defecto: **intrale** (Projects V2).

> Ver módulos específicos para flujo, PRs, refinamiento y documentación.
