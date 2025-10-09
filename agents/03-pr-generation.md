# 🔄 Generación de Pull Requests (política Codex)

Base obligatoria del PR:
- **`base = develop`** siempre.
- Excepción solo si el issue tiene etiqueta `release` o `hotfix`.

Rama de origen:
- Debe iniciar con `codex/` y seguir `codex/<issue>-<slug>`.

Secuencia:
1) Crear rama desde `origin/develop` (o rechazar si no es posible).
2) Commits claros y relacionados al issue.
3) Crear PR:
   - Título: `[auto] <breve>` + ` (Closes #<issue>)`
   - Cuerpo: detalle técnico + enlaces
   - Asignar a `leitolarreta`
4) Comentar en el issue con link al PR y evidencias.
5) Mover issue a **Ready** sólo si:
   - El PR fue creado con base `develop`
   - Está asignado a `leitolarreta`
   - Contiene `Closes #<issue>` en título o cuerpo

Restricciones:
- ❌ No abrir PR hacia `main` (salvo `release/hotfix`).
- ❌ No hacer merge automático del PR.
