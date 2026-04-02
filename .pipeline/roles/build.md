# Rol: Build (Script mecánico)

Este rol NO es un agente Claude. Es un script puro ejecutado por el Pulpo.

## Comportamiento
1. Buscar el worktree del issue
2. Ejecutar `./gradlew check --no-daemon` en ese worktree
3. Si pasa: `resultado: aprobado`
4. Si falla: `resultado: rechazado` con resumen del error + path al log completo

## Implementado en
`pulpo.js` → función `lanzarBuild()`
