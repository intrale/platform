# Protocolo de seguridad del pipeline V2

Este documento describe los 5 mecanismos que protegen al pipeline de quedar fuera de servicio por un cambio defectuoso. Están pensados para sostener la evolución del pipeline por agentes (futuro rol `pipeline-dev`) sin que un error pueda dejar el sistema caído.

## 1. Tag automático `pipeline-stable`

Cada vez que un `/restart` termina con el smoke test en verde, el tag `pipeline-stable` se mueve al HEAD actual (local y push a `origin`). Es la última versión verificada como operativa.

- Se mueve únicamente cuando el smoke test pasa (exit 0).
- Se intenta mover y pushear en **todos** los smoke limpios, no sólo cuando el tag local quedó desalineado: `git tag -f` y el push son idempotentes, y así un tag local correcto con el remoto atrasado también se corrige (#5723).
- **Excepción**: si `.pipeline/` en disco difiere del commit de HEAD, el tag **no** se mueve y se avisa por Telegram. Ese es el estado típico post-rollback (HEAD apunta a un commit pero el código en disco viene de otro): taggear ahí grabaría como "estable" algo que nunca corrió.
- Queda disponible como target de rollback desde cualquier rama.
- No requiere intervención manual.

> **Que el tag quede atrás de HEAD no es cosmético.** Es la precondición del incidente del 2026-08-09: si el fix de un bug del lifecycle ya está en `main` pero el tag no avanzó, el rollback automático borra ese fix. Ver sección 4.1.

## 2. Smoke test post-restart (`.pipeline/smoke-test.sh`)

Bash puro. No depende de Node ni del pipeline vivo — solo de `bash`, `git`, `curl` y acceso al filesystem. Se corre automáticamente al final de `restart.js`.

Chequeos:
1. Procesos críticos (`pulpo`, `dashboard`, `svc-telegram`) tienen PID file y proceso vivo.
2. Dashboard responde HTTP 200 en `:3200/api/state`.
3. `last-restart.json` existe y es reciente (< 5 min).
4. Warnings sobre mensajes huérfanos en `commander/trabajando/`.

Exit codes:
- `0` — pipeline sano → mueve tag `pipeline-stable`
- `1` — fallo crítico (componente caído) → auto-rollback
- `2` — fallo de conectividad (dashboard no responde) → auto-rollback
- `3` — fallo de estado (archivos corruptos o stale) → auto-rollback

## 3. Rollback de emergencia (`.pipeline/rollback.js`)

Node puro, detached-safe, ejecutable aunque el pipeline esté muerto o corrupto. (Existe todavía un `.pipeline/rollback.sh` legacy que ya no invoca nadie desde el código; su unificación se sigue en #5729.)

Flujo:
0. **Planifica sin tocar nada**: resuelve el target y evalúa el guard con lecturas de git puras (ver 4.1). Si el guard frena, el pipeline queda como está — vivo, con el código actual.
1. Loguea en `logs/rollback.log` el diffstat y los commits que está por revertir, **antes** de revertirlos.
2. Mata todo proceso del pipeline.
3. `git checkout <target> -- .pipeline/` (reset quirúrgico, no afecta otros archivos — incluye `.pipeline/roles/`).
4. Relanza el pipeline con `node restart.js --no-smoke-test --no-rollback`.
5. Notifica por Telegram con el tono que corresponde: un rollback que revierte commits nunca es un ✅.

Uso manual:
```bash
node .pipeline/rollback.js                  # → pipeline-stable
node .pipeline/rollback.js <sha|tag>        # → commit específico
node .pipeline/rollback.js --dry-run        # → qué se perdería, sin tocar nada
node .pipeline/rollback.js --force          # → ignorar el corte del guard
```

Requisitos mínimos: `git`, `node`.

## 4. Auto-rollback en `restart.js`

Si el smoke test falla después del `/restart`, `restart.js` lanza `rollback.js pipeline-stable` como orphan detached y envía una notificación por Telegram describiendo la causa. Las banderas relevantes:

- `--no-smoke-test` → deshabilita el smoke test (para el propio rollback y casos especiales).
- `--no-rollback` → corre smoke test pero no dispara rollback (diagnóstico).

La condición para auto-rollback es: smoke test exit ≠ 0 **y** existe el tag `pipeline-stable` (si no existe, es el primer deploy y no hay a dónde volver).

### 4.1 Guard anti auto-destrucción (#5723)

El rollback asume que `pipeline-stable` es siempre un estado **mejor** que el actual. Cuando el fix de un bug del propio lifecycle ya está mergeado en `main` pero el tag no avanzó, esa premisa se invierte y el rollback pasa a ser el mecanismo que **impide** la recuperación. El 2026-08-09 revirtió 22 archivos y 2407 líneas (los fixes #5704 y #5687), volvió a fallar por la misma causa y volvió a rollbackear: dos ciclos completos antes de la intervención manual. El mismo patrón había ocurrido el 2026-04-30 con `svc-reconciler` (3 ciclos).

El guard **no es incondicional**: en operación normal `pipeline-stable` es siempre ancestro de HEAD, así que frenar por "ancestro + toca lifecycle" desactivaría el rollback para todo cambio en los archivos del lifecycle, incluido el caso legítimo de revertir un commit malo. La regla es:

| Ciclo | Comportamiento |
|---|---|
| 1er rollback hacia un target | Revierte. Antes loguea el diffstat y avisa por Telegram qué se pierde. Si el target es ancestro de HEAD **y** el diff toca `restart.js`, `pulpo.js`, `watchdog.ps1` o `smoke-test.js`, la alerta escala a 🚨. |
| 2do rollback consecutivo hacia el **mismo** target, sin smoke limpio en el medio | **Frena.** No mata procesos ni revierte. Aplica `needs-human` a los issues de los commits involucrados y alerta que el pipeline quedó detenido. |
| 3 rollbacks seguidos sin smoke limpio (aunque cambie el target) | Frena igual. |

Estado en `.pipeline/rollback-state.json` (gitignored, escritura atómica). Un smoke test limpio lo borra y destraba el corte. Notas operativas:

- El archivo vive **fuera** del árbol versionado a propósito: el rollback hace `git checkout <target> -- .pipeline/` y se llevaría puesto cualquier estado trackeado. Un `git clean -xdf` sí lo borra, y el contador vuelve a cero.
- Tiene una ventana de frescura de 6 h: un corte no queda pegado para siempre. Hace falta porque tras un rollback el `restart.js` en disco es el **viejo** (revertido), que no sabe resetear el contador.
- El override manual es `node .pipeline/rollback.js --force`.
- Para ver qué se perdería sin ejecutar nada: `node .pipeline/rollback.js --dry-run`.

**El destrabe manual es siempre el mismo comando** — por eso las alertas lo traen escrito:

```bash
git tag -f pipeline-stable <sha-bueno> && git push origin --force pipeline-stable
```

## 5. CODEOWNERS: review obligatorio de cambios críticos

`.github/CODEOWNERS` obliga a que cada PR que toque `.pipeline/` (incluido `.pipeline/roles/`) o `.github/` tenga review explícito de `@leitolarreta` antes de mergear. Esto es la última línea: aunque los agentes se automaticen, un humano revisa cualquier cambio que pueda romper la orquestación.

> Requiere que branch protection esté activado en GitHub con "Require review from Code Owners" marcado. Si no lo está, CODEOWNERS aún sirve como asignación automática de reviewers.

## Flujo de evolución esperado

1. `pipeline-dev` (o cualquier agente/humano) abre un PR tocando `.pipeline/` (incluye `.pipeline/roles/`).
2. CODEOWNERS asigna review a `@leitolarreta`.
3. Leo aprueba y mergea.
4. Alguien dispara `/restart` (manual o desde Telegram).
5. `restart.js` sincroniza con `main`, relanza procesos, corre smoke test.
6. Si OK → tag `pipeline-stable` avanza al nuevo HEAD.
7. Si FAIL → auto-rollback al `pipeline-stable` anterior + alerta Telegram, salvo que el guard de 4.1 lo frene.

En el peor caso (todo se rompió y el pipeline no responde):

```bash
# Desde cualquier terminal, sin pipeline vivo:
node C:/Workspaces/Intrale/platform/.pipeline/rollback.js --dry-run   # ver qué se perdería
node C:/Workspaces/Intrale/platform/.pipeline/rollback.js             # ejecutarlo
```
