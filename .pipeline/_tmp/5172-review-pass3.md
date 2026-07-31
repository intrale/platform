## Code review `review` — RECHAZADO

Rama `agent/5172-pipeline-dev` @ `3e70357a5` (no hay PR abierto todavía). El linter pasó (0 errores, 3 warnings). Revisión **semántica**, sin repetir lo mecánico.

### Lo que está bien (verificado, no citado)

- **CA-2 · punto único**: el guard corre limpio sobre el HEAD commiteado, no sobre el worktree:
  ```
  $ git grep -nE "yaml\.load\s*\([^)]*(config\.yaml|CONFIG_PATH|CONFIG_FILE|cfgPath|configPath|CONFIG_REL)" HEAD -- '.pipeline/**/*.js' | grep -v _tmp/ | grep -v __tests__ | grep -v '\.test\.js'
  HEAD:.pipeline/lib/config-resolver.js:9         # comentario
  HEAD:.pipeline/lib/kernel-action-policy.js:108  # comentario
  HEAD:.pipeline/lib/operator-absence-policy.js:68 # comentario
  ```
  Cero lecturas reales fuera del resolver.
- **Cobertura del módulo nuevo — 98.19% líneas** (mínimo exigido 90%), 49/49 tests verdes.
- **Regresiones verdes**: `pulpo-config-recovery` (#4832), `durable-cutover` (#4821), `config-schema`, `error-classifier`, `reconciler-admission-sweep`, `multi-provider-health-cron`, `waves` → 135 + 47 pass, 0 fail.
- **SEC-1**: el error de `js-yaml` nunca se encadena ni se reexpone; `redactYamlParseError` devuelve sólo posición. El fix obligatorio de `planner-waves-cli.js:68` (D-F) está hecho.
- **D-G**: `ConfigParseViolation` registrado en `error-classifier.js` y sin `err.code`, así que no se degrada a `transient`.
- `servicio-reconciler.admissionGateSettings()` es el mejor ejemplo del patrón: config ilegible **mantiene el gate encendido** y aplica igual los overrides con traza.
- `config.yaml` sólo cambia comentarios; ningún valor ni clave se movió.
- Merge con `origin/main` sin conflictos.

---

### 🔴 BLOQUEANTE 1 — La migración introdujo un fail-open nuevo en el flag de cuota

`lib/quota-exhausted.js:1183-1193` (`loadQuotaDetectorConfig`) pasó a propagar, correcto en sí mismo. El problema es **dónde cae ese throw**: `resolveMaxDays()` se invoca dentro de `setFlag()` (l.1041), o sea en el camino de **escritura** del flag de cuota agotada.

Reproducción aislada sobre el HEAD de la rama:

```
$ mkdir -p /tmp/qp2 && printf 'pipelines:\n  desarrollo:\n   mal: [\n' > /tmp/qp2/config.yaml
$ PIPELINE_DIR_OVERRIDE=/tmp/qp2 node -e "q.setFlag({provider:'anthropic',errorType:'usage_limit_reached',rawExcerpt:'429 quota'})"
setFlag(sin maxDays) => THREW ConfigParseViolation / yaml-invalido
quota-exhausted.json existe: false
```

Y con `maxDays` explícito, **misma config corrupta**, el flag sí se persiste — lo que aísla la causa a `resolveMaxDays` y a nada más:

```
$ PIPELINE_DIR_OVERRIDE=/tmp/qp node -e "q.setFlag({..., maxDays:2})"
con maxDays explicito => OK
$ ls -la /tmp/qp/quota-exhausted.json
-rw-r--r-- 1 Administrator 197121 397 jul. 31 14:10 /tmp/qp/quota-exhausted.json
```

El único call-site de producción no pasa `maxDays` y traga el throw (`lib/agent-launcher/dispatch-with-fallback.js:444-455`):

```js
                    _quota.setFlag({ provider, errorType, rawExcerpt: safeEvidence, agent: skill || null });
                    flagSet = true;
            } catch (e) {
                try { log('lanzamiento', `... onSpawnExit: setFlag tiró (best-effort): ${e && e.message}`); } catch {}
            }
```

**Efecto neto:** con `config.yaml` corrupto, un agente que muere por 429 **ya no deja el flag de cuota agotada**, y `flagSet` queda `false`. Antes de esta migración el `catch { defaults }` sí lo escribía. Lo que dispara el throw es apenas un **cap de TTL** cuyo default (`DEFAULT_MAX_RESETS_AT_DAYS = 7`, clampeado a `[MIN_TTL_DAYS, MAX_TTL_DAYS]`) es perfectamente seguro: una lectura no crítica se está llevando puesto un camino de escritura crítico.

Es el fail-open que la historia existe para eliminar, con el signo invertido. Que el `.paused` global del pulpo frene el dispatch en ese escenario no alcanza como mitigación: es un efecto colateral de otro subsistema, no una decisión de diseño de este camino, y no cubre a los agentes ya en vuelo.

**Cambio requerido:** que `resolveMaxDays()` capture `isConfigViolation(e)`, use el default conservador ya clampeado y deje traza; o que `setFlag()` resuelva el TTL **después** de persistir el slot. Con test que fije: config corrupta + `setFlag` sin `maxDays` ⇒ el flag se escribe igual.

---

### 🔴 BLOQUEANTE 2 — La separación G-3 de los runners es sólo de texto, no de política

La receta técnica del issue lo pide explícitamente para estos dos archivos: *"separar los caminos — `MODULE_NOT_FOUND` sigue fail-soft a defaults; corrupción de config es fail-closed"*.

En `pulpo-liveness-run.js:86-104` el `if/else` discrimina **únicamente el mensaje de log**: las dos ramas caen al mismo `return {}`.

```js
    if (err && err.code === 'MODULE_NOT_FOUND') {
      log('DEGRADACION: config-resolver no cargable ...');
    } else {
      log(`DEGRADACION: config.yaml ilegible o inválido (causa=...)`);
    }
  }
  return {};
```

El delta de valores es material:

```
$ grep -n pulpo_liveness_kill_seconds .pipeline/config.yaml
474:  pulpo_liveness_kill_seconds: 180
$ grep -n DEFAULT_KILL_SECONDS .pipeline/lib/pulpo-liveness.js
34:const DEFAULT_KILL_SECONDS = 90;
```

Un `config.yaml` corrupto **reduce a la mitad el umbral de "el Pulpo es zombi, matalo"** (180s → 90s), en el componente cuyo único trabajo es decidir si matar al Pulpo — y el propio comentario del config dice que ese margen existe para evitar falsos positivos y restart-storms. La primitiva fail-closed ya existe a un valor de distancia (`lib/pulpo-liveness.js:118-121`: umbral no finito ⇒ `'skip'`).

Aclaro con honestidad: **esto no es una regresión de este PR** — en `origin/main` el comportamiento era idéntico y además mudo. Lo bloqueo porque es un ítem explícito de la receta del issue, el comentario nuevo afirma una separación que el código no hace, y la dirección de la degradación es destructiva.

`watchdog-supervisor-run.js:85-103` tiene el mismo patrón. Hoy es latente (los 4 valores del config coinciden con los defaults del módulo), pero se vuelve real apenas alguien suba `supervisor_max_restarts`. Misma corrección.

**Nota adicional del mismo bloque:** la discriminación es `err.code === 'MODULE_NOT_FOUND'` vs *todo lo demás*, no `isConfigViolation(err)`. Verifiqué que ningún error tipado setea `.code`, así que el catch de `MODULE_NOT_FOUND` **no** se come los de config — pero al revés sí: un `TypeError` del resolver se loguea como *"config.yaml ilegible o inválido (causa=desconocida)"*. El predicado único existe justamente para esto.

---

### Observaciones no bloqueantes

- **Scope creep**: el commit `b3863bfbd` (credenciales de Drive al store externo — `lib/credentials.js`, `qa-video-share.js`, `google-drive-oauth-setup.js`, docs) no tiene relación con el objetivo de #5172. Está bien hecho y con tests, pero infla un PR que el linter ya marcó como grande (71 archivos, +4490/-378) y complica el "revertible en minutos" del último CA. Idealmente va en su propio PR.
- **Ningún commit referencia `Closes #5172`** (warning del linter): asegurarse de incluirlo en el body del PR.
- `lib/project-bootstrap.js` llama `resolve({configPath})` **sin** `reload`, así que `kernel.durable` queda cacheado por proceso. En pulpo y dashboard es inocuo (ambos refrescan la misma entrada con `reload:true`), pero conviene tenerlo presente para el cutover de #5126.
- Perf menor: `_loadGuardRawConfig` usa `reload:true` y se invoca 2-3 veces por poll de `/api/dash/quota`, re-parseando y re-validando los ~46KB de YAML cada vez.

### Recomendaciones registradas como issues independientes (requieren aprobación humana)

- #5296 — dejar traza de la causa cuando `canonical-facts` no puede leer la config.
- #5297 — hacer visible el error de config en el KPI de entregables por skill.
- El copy de `planner-waves-cli` ya estaba cubierto por #5271, no dupliqué.
