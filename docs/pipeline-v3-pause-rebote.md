# Pipeline V3 — Contrato de Pausa + Rebote infra vs código

Issue de referencia: [#2374](https://github.com/intrale/platform/issues/2374).

Este documento congela el contrato de dos mecanismos del pulpo cuya semántica
era ambigua hasta esta historia:

1. **`.paused`** — el archivo marker que detiene el procesamiento del pipeline.
2. **`rebote_tipo` (infra vs código)** — dónde se re-encola un issue cuando el
   pipeline detecta un rechazo según la naturaleza del fallo.

---

## 1. Contrato del archivo `.paused`

### Activación / desactivación

- Crear: `touch .pipeline/.paused` (o bien `node .pipeline/restart.js --paused`).
- Borrar: `rm .pipeline/.paused` (o bien `node .pipeline/restart.js`, que parte
  el lifecycle nuevo sin el marker, salvo `--paused`).
- Coexistencia con `.partial-pause.json`: **`.paused` tiene precedencia** sobre
  cualquier allowlist. La tabla de verdad vive en `.pipeline/lib/partial-pause.js`.

### Qué hace el pulpo cuando `.paused` está presente

| Subsistema | Comportamiento | Implementación |
|------------|----------------|----------------|
| **Intake (GitHub → pipeline)** | **Bloqueado.** No se lee `gh issue list`, no se crean archivos en `*/pendiente/`. | `pulpo.js` `brazoIntake`, gate explícito al inicio del brazo. |
| **Lanzamiento de nuevos agentes** | **Bloqueado.** No se llama a `lanzarAgenteClaude` ni se promueven worktrees. | `pulpo.js` loop principal: `if (!paused) { brazoLanzamiento(...) }`. |
| **Barrido / promoción entre fases** | **Bloqueado.** Archivos en `listo/` NO se promueven a la siguiente fase mientras dura la pausa — se acumulan. Al despausar, el barrido drena lo acumulado en orden. | `pulpo.js` loop principal: `if (!paused) { brazoBarrido(...) }`. |
| **Watchdog / brazoHuerfanos** | **Bloqueado.** Archivos en `trabajando/` no se marcan como huérfanos por timeout durante la pausa. | `pulpo.js` loop principal: `if (!paused) { brazoHuerfanos(...) }`. |
| **Agentes en vuelo** | **Siguen corriendo.** No se les manda señal de kill. La pausa NO mata trabajo en progreso. | El loop pausado no toca procesos. |
| **Exit handler de agente que termina** | **Se ejecuta.** Cuando un agente termina mientras `.paused` está activo, su `child.on('exit')` corre en memoria del pulpo (sigue vivo) y mueve `trabajando/<N>.<skill>` → `listo/<N>.<skill>`. | `pulpo.js` `child.on('exit', ...)` ~línea 5501. |
| **Servicios auxiliares (telegram, dashboard, github, drive, emulador, reconciler)** | **Siguen corriendo.** Cada servicio tiene su propio gate de pausa si decidió respetarla; la mayoría sirve estado y no inyecta trabajo. | Procesos hijos del `restart.js`, independientes del loop del pulpo. |
| **Detector de cuota Anthropic** | **Corre siempre.** `pollQuotaFlag()` no respeta la pausa porque su objetivo es liberar el gate cuando se restaura la cuota, y eso debe pasar también en estado pausado. | `pulpo.js` loop principal, fuera del `if (!paused)`. |

### Lo que NO hace el `.paused`

- **NO mata agentes en vuelo.** Si querés frenar todo en caliente (incluido el
  trabajo en progreso), `node .pipeline/restart.js stop` mata el árbol entero.
- **NO bloquea el dashboard ni Telegram.** Esas superficies son de lectura;
  bloquearlas dejaría operativamente ciego al operador.
- **NO afecta el routing-mismatch ni el cross-phase rebote.** Esos flujos pasan
  por barrido — y barrido está bloqueado — así que efectivamente no corren,
  pero no porque tengan gate propio: porque viven dentro de un brazo bloqueado.

### Modos futuros (opcionales — NO implementados en esta historia)

El issue #2374 contempla evolucionar el contrato a tres modos:

- `.paused` (actual) → bloqueado todo el lifecycle salvo telemetría.
- `.paused-hard` → además congela exit handlers (drenaje cero).
- `.paused-drain` → no lanza nuevos, espera a que todos los `trabajando/` migren a `listo/`.

Si llegan a implementarse, el archivo será reemplazado por un JSON con `mode`
explícito (mismo patrón que `.partial-pause.json`), preservando el archivo
desnudo `.paused` como alias de `mode: full` por compatibilidad.

---

## 2. Contrato del rebote — infra vs código

### Clasificación

La clasificación se hace en `pulpo.js` (fuente de verdad: `lib/rebote-classifier.js`)
sobre el conjunto de motivos de los archivos en `listo/` que reportaron
`resultado: rechazado`. La precedencia de categorías es:

```
cross_phase > dependency_block > human_block > infra > code
```

Para los tipos de rebote que afectan el destino (este documento):

- **`infra`** — la causa raíz es de infraestructura: timeout de watchdog, crash
  del child, error de red/DNS/TLS, pérdida transitoria de capacidad del LLM.
  El código del issue no tiene defecto que corregir.
- **`code`** — la causa raíz es código que el dev escribió: tests fallan, review
  bloquea por arquitectura, QA detecta defecto funcional, linter rechaza.

### Destino del rebote

Implementación pura en `.pipeline/lib/rebote-destino.js` (función
`resolveReboteDestino`).

| Tipo | `faseDestino` | `skillsDestino` | Por qué |
|------|---------------|-----------------|---------|
| `code` | `faseRechazo` (config — para `desarrollo` es `dev`) | `[determinarDevSkill(issue, config)]` | El dev tiene que corregir el código. El skill se elige por labels del issue (backend-dev, android-dev, web-dev, pipeline-dev). |
| `infra` en fase mono-skill (`dev` / `build` / `entrega`) | Misma fase | `[único skill]`. Para `dev`, `determinarDevSkill(...)`. | Reintento puro — no hay nada que el dev corrija. |
| `infra` en fase paralela (`validacion` / `verificacion` / `aprobacion`) | Misma fase | **TODOS** los `skills_por_fase[fase]` | Los archivos en `listo/` de skills que aprobaron se mueven a `procesado/` al final del barrido. Si re-encoláramos sólo el skill que falló por infra, la próxima evaluación quedaría incompleta para siempre (faltan los resultados de los demás skills_requeridos). |

### Circuit breaker independiente

- `MAX_REBOTES = 3` — rebotes de código consecutivos antes de escalar (label
  `needs-human`, alerta Telegram).
- `MAX_REBOTES_INFRA = 20` (cap duro) — contador separado `rebote_numero_infra`
  que **no consume** el budget de código.
- `infra_escalate_threshold = 5` (config.yaml `circuit_breaker.*`) —
  threshold blando: a partir de N rebotes infra consecutivos, se aplica
  `needs-human` y se notifica, aunque no se haya alcanzado el cap duro.

Esto evita el bucle histórico: timeouts de CI en delivery devolvían el issue a
backend-dev, que rebotaba 3 veces sin tocar nada, y se escalaba a humano por un
problema que no tenía solución de código.

### Ejemplo canónico (incidente #2159)

```
1. desarrollo/entrega/trabajando/2159.delivery        ← agente delivery corriendo
2. watchdog timeout 90min (CI tarda 28m por OWASP)    ← clasificación: infra
3. ANTES (regresión #2374): desarrollo/dev/pendiente/2159.backend-dev
   → re-run de backend-dev + builder + tester + qa + review + delivery (horas)
4. AHORA: desarrollo/entrega/pendiente/2159.delivery
   → re-run de delivery únicamente. rebote_numero_infra=1, rebote_numero=0.
```

---

## 3. Diagnóstico operativo

### Verificar el estado de pausa
```bash
ls -la .pipeline/.paused .pipeline/.partial-pause.json 2>/dev/null
node -e "console.log(JSON.stringify(require('./.pipeline/lib/partial-pause').getPipelineMode(), null, 2))"
```

### Ver clasificación reciente de rebotes
```bash
grep -E "rebote_tipo|RECHAZADO en .* (por INFRA|→ devuelto)" .pipeline/logs/pulpo.log | tail -50
```

### Forzar despausa total
```bash
node -e "require('./.pipeline/lib/partial-pause').resumeAll()"
```

---

## 4. Tests que congelan el contrato

- `.pipeline/lib/__tests__/rebote-destino.test.js` — destino del rebote para
  cada combinación tipo × fase, fallbacks defensivos.
- `.pipeline/lib/__tests__/partial-pause.test.js` — tabla de verdad de
  precedencia `paused > partial_pause > running`.
- `.pipeline/lib/__tests__/rebote-classifier.test.js` — categorías canónicas
  con precedencia y patrones de detección.

Cualquier cambio que rompa estos tests viene a este documento primero.
