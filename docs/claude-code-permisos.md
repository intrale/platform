# Configuración de Permisos en Claude Code

Este documento describe la configuración recomendada de permisos para Claude Code en el proyecto Intrale Platform.

## Archivo de configuración

La configuración local se almacena en `.claude/settings.local.json` (ignorado por `.gitignore` para ser específico por usuario).

## Configuración recomendada

### Allow Rules (14 patrones)

Comandos autorizados sin solicitar confirmación:

```json
{
  "permissions": {
    "allow": [
      "Bash(cd:*)",           // Cambio de directorio
      "Bash(find:*)",         // Busqueda de archivos
      "Bash(grep:*)",         // Busqueda en contenido
      "Bash(echo:*)",         // Echo / imprimir texto
      "Bash(tail:*)",         // Ver final de archivos
      "Bash(ls:*)",           // Listar archivos
      "Bash(head:*)",         // Ver inicio de archivos
      "Bash(export:*)",       // Cualquier export de variable
      "Bash(export PATH=*)",  // Export PATH (específico)
      "Bash(export GH_TOKEN=*)", // Export GH_TOKEN (específico)
      "Bash(git:*)",          // Todos los subcomandos git
      "Bash(gh:*)",           // Todos los comandos GitHub CLI
      "Bash(./gradlew:*)",    // Cualquier tarea Gradle
      "Skill(delivery)"       // Skill de delivery
    ]
  }
}
```

### Deny Rules (7 patrones)

Operaciones explícitamente bloqueadas:

```json
{
  "permissions": {
    "deny": [
      "Bash(git push --force*)",   // Force push
      "Bash(git push -f*)",        // Force push (short)
      "Bash(git reset --hard*)",   // Reset destructivo
      "Bash(git clean -f*)",       // Limpiar archivos
      "Bash(git clean -fd*)",      // Limpiar archivos y dirs
      "Bash(rm -rf*)",             // Borrado recursivo forzado
      "Bash(rm -r *)"              // Borrado recursivo
    ]
  }
}
```

## Cómo aplicar esta configuración

1. Abre `.claude/settings.local.json` en la raíz del proyecto
2. Copia el contenido de las secciones `allow` y `deny` mostradas arriba
3. Guarda el archivo
4. La próxima vez que ejecutes Claude Code en este workspace, los permisos estarán vigentes

## Permisos adicionales automáticos

Además de la configuración explícita, Claude Code tiene:

- **Operaciones de archivo dentro del workspace**: crear, editar y borrar archivos/directorios
  NO requieren confirmación (autorizado por defecto)
- **Auto-learning**: El hook `permission-tracker.js` detecta comandos aprobados manualmente
  y los persiste automáticamente en `settings.local.json` para futuras sesiones

## Permisos que requieren confirmación manual

Las siguientes acciones siempre solicitan confirmación:

- Operaciones AWS (comandos `aws cli`)
- Modificar CI/CD (cambios en GitHub Actions workflows)
- Modificar infraestructura (configuración de infra)

## Notas técnicas

- Los patrones usan el formato `Tool(patrón:*)` donde:
  - `Bash(comando:*)` — cualquier comando bash que empiece con `comando`
  - `Skill(nombre)` — skill de Claude Code con ese nombre
- La sección `deny` tiene precedencia sobre `allow` — las deny rules no pueden ser
  sobrescritas
- Para cambios en los permisos, edita `.claude/settings.local.json` directamente
  y reinicia la sesión de Claude Code

## Referencias

- [Memory — Permisos](../../../Users/Administrator/.claude/projects/C--Workspaces-Intrale-platform/memory/permissions.md)
- [CLAUDE.md — Instrucciones generales](./CLAUDE.md)
