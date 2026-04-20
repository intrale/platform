# Protocolo de seguridad del pipeline V2

Este documento describe los 5 mecanismos que protegen al pipeline de quedar fuera de servicio por un cambio defectuoso. Están pensados para sostener la evolución del pipeline por agentes (futuro rol `pipeline-dev`) sin que un error pueda dejar el sistema caído.

## 1. Tag automático `pipeline-stable`

Cada vez que un `/restart` termina con el smoke test en verde, el tag `pipeline-stable` se mueve al HEAD actual (local y push a `origin`). Es la última versión verificada como operativa.

- Se mueve únicamente cuando el smoke test pasa (exit 0).
- Queda disponible como target de rollback desde cualquier rama.
- No requiere intervención manual.

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

## 3. Rollback de emergencia (`.pipeline/rollback.sh`)

Bash puro, ejecutable aunque el pipeline esté muerto o corrupto.

Flujo:
1. Mata todo proceso del pipeline.
2. `git fetch` del target (default `pipeline-stable`).
3. `git checkout <target> -- .pipeline/` (reset quirúrgico, no afecta otros archivos — incluye `.pipeline/roles/`).
4. Relanza el pipeline con `node restart.js --no-smoke-test`.

Uso manual:
```bash
bash .pipeline/rollback.sh                  # → pipeline-stable
bash .pipeline/rollback.sh <sha|tag>        # → commit específico
```

Requisitos mínimos: `bash`, `git`, `node`. No depende de ningún `.js` del pipeline.

## 4. Auto-rollback en `restart.js`

Si el smoke test falla después del `/restart`, `restart.js` ejecuta `rollback.sh pipeline-stable` automáticamente y envía una notificación por Telegram describiendo la causa. Las banderas relevantes:

- `--no-smoke-test` → deshabilita el smoke test (para el propio rollback y casos especiales).
- `--no-rollback` → corre smoke test pero no dispara rollback (diagnóstico).

La condición para auto-rollback es: smoke test exit ≠ 0 **y** existe el tag `pipeline-stable` (si no existe, es el primer deploy y no hay a dónde volver).

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
7. Si FAIL → auto-rollback al `pipeline-stable` anterior + alerta Telegram.

En el peor caso (todo se rompió y el pipeline no responde):

```bash
# Desde cualquier terminal, sin pipeline vivo:
bash C:/Workspaces/Intrale/platform/.pipeline/rollback.sh
```
