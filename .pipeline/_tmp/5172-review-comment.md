## Code review (fase `aprobacion`) — RECHAZADO

Rama `agent/5172-pipeline-dev` · 6 commits · 67 archivos (+3983 −367). Linter previo: aprobado (3 warnings, 0 errores).

### Lo que está bien (verificado, no citado)

- `lib/config-resolver.js` implementa D-1..D-4 tal como los cerró el architect: precedencia de raíz con el argumento primero, caché por ruta con `reload`, `resolveForDiff` sin lanzar/cachear/trazar, y allowlist **cerrada** de overrides por env.
- **Suite completa verde**: `node --test .pipeline/lib/__tests__/*.test.js` → `tests 6482 · pass 6481 · fail 0 · skipped 1`.
- **Cobertura del módulo nuevo 98.73% líneas** (≥90% exigido).
- **El guard NO es vacuo** — lo probé plantando una violación real:
  ```
  $ # creo .pipeline/lib/zz-guard-probe.js con yaml.load(config.yaml) + catch {}
  $ node --test .pipeline/lib/__tests__/config-resolver-guard.test.js
  ✖ CA-2 · ningún archivo de producción conserva su propio yaml.load de config.yaml
      actual: [ 'lib/zz-guard-probe.js' ]
  ```
- Regresión #4832 intacta y verde (`pulpo-config-recovery.test.js` sin editar); `pulpo.loadConfig()` conserva `haltOnConfigCorruption` + `lastGoodConfig` + auto-recovery, sin `process.exit`.
- SEC-1 cerrado donde importa: `redactYamlParseError` devuelve sólo `{causa, linea, columna}`; `renderConfigErrorPage` usa `detalle`/`accion`/`archivo`/`via`, nunca `err.message`; la fuga de `planner-waves-cli.js:68` está eliminada y el CLI hace `exit 1`.
- La edición de `durable-cutover.test.js` **fortalece** la regresión (pasa de afirmar fail-open a exigir `ConfigParseViolation`) y está justificada en el propio test. Correcto.

---

### 🔴 BLOQUEANTE — la migración introdujo un fail-open silencioso en GATE 3

`pulpo.js:16146-16172` · `lib/kernel-action-policy.js:132-138`

`loadGate3Config` está bien migrado (propaga el error tipado). El problema es que **el consumidor tiene un `catch {}` mudo preexistente que no se tocó**, y la migración le cambió el contrato de error por debajo:

```js
// pulpo.js:16157-16166
const gate3 = require('./lib/kernel-action-policy').enforceActionPolicy('realign-allowlist', {...});
if (!gate3.proceed) {
  return { ok: false, reason: 'gate3_confirmation_required', policy: gate3 };
}
} catch {}                                   // ← se traga el ConfigParseViolation
return require('./lib/wave-dispatch').realignActiveWaveDispatch({...});   // muta igual
```

Verificado empíricamente en esta pasada, con un `config.yaml` corrupto en tmpdir vía `PIPELINE_DIR_OVERRIDE`:

```
# DESPUÉS (esta rama)
$ node repro.js
LANZO -> ConfigParseViolation | causa = yaml-invalido

# ANTES (el `catch { return {} }` de origin/main degradaba a `{}`,
#        que es exactamente lo que inyecta opts.config)
$ node repro-antes.js
ANTES -> proceed = false | mode = wait-confirmation | source = undefined
```

Y en `origin/main` el catch existía:
```
$ git show origin/main:.pipeline/lib/kernel-action-policy.js | sed -n '119,126p'
    try { ... yaml.load(...) ... } catch { return {}; }
```

**Inversión estricta del comportamiento:**

| | config ilegible → `realign-allowlist` (impacto `alto`) |
|---|---|
| **Antes** | `{}` → `DEFAULT_POLICY = 'wait-confirmation'` → `proceed:false` → **mutación bloqueada** |
| **Ahora** | `resolve()` lanza → `catch {}` lo traga → **la allowlist se realinea sin GATE 3 y sin una línea de traza** |

Esto es precisamente la clase de fallo que el issue dice eliminar ("elimina esa clase de fallo silencioso"), reintroducida en una acción de impacto `alto`. **Fix mínimo**: tratar "no pude leer la política" como `proceed:false` — distinguir el error de config dentro de ese catch, o sacar el `enforceActionPolicy` del `try`.

Mismo patrón, sin mutación extra pero perdiendo la notificación al operador: `lib/desync-detector.js:315`, `lib/quota-exhausted.js:770` y `:1056`, `restart.js:126`, `lib/parallel-lane-classifier.js:193`. Conviene barrerlos en el mismo pase.

---

### 🟠 Cambios requeridos (secundarios, verificados)

**1. Los dos runners colapsan corrupción y `MODULE_NOT_FOUND` en la misma salida** — `pulpo-liveness-run.js:86-104`, `watchdog-supervisor-run.js:85-103`

La receta del architect lo pide explícito: *"separar los caminos — `MODULE_NOT_FOUND` sigue fail-soft a defaults; corrupción de config es fail-closed"*. Hoy bifurcan **sólo el texto del log** y ambos ramales terminan en `return {}`. Efecto real medible: `config.yaml` declara `pulpo_liveness_kill_seconds: 180` pero `DEFAULT_KILL_SECONDS = 90` (`lib/pulpo-liveness.js:34`), así que una config corrupta **acorta el umbral a la mitad** y aumenta el riesgo de kills por falso positivo y restart-storms — el mismo riesgo que el comentario de `config.yaml:471` dice estar evitando.

Además: cobertura cero. `grep -rn "liveness-run\|supervisor-run" .pipeline/lib/__tests__/` → 0 hits. Ni el ramal `MODULE_NOT_FOUND` ni el de corrupción están testeados.

**2. `FALLBACK_PHASE_ORDER` sigue cubriendo "config ilegible"** — `servicio-reconciler.js:418-433`

```js
} catch (e) {
    logConfigFailure(e);       // ← orders queda en FALLBACK_PHASE_ORDER
}
```
El CA pide que el FALLBACK cubra sólo la **sección ausente**. Mitigado (loguea con throttle y `if (confirmado)` evita cachear el fallback), pero alimenta `isNeedsHumanStaleByProgress`, que puede sacar `needs-human` con un orden nunca confirmado contra el archivo. O se hace fail-closed, o se documenta la excepción como decisión deliberada igual que las otras.

**3. CA-8 cubre sólo la home** — `dashboard.js:698`

`PAGINAS_HTML = ['/', '', '/v3', '/v3/', '/dashboard', '/dashboard/', '/legacy', '/legacy/']`, pero también son páginas HTML `/equipo`, `/bloqueados`, `/matriz`, `/ops`, `/providers`, `/kpis`, `/costos` (`lib/dashboard-routes.js:1118-1142`). Esas pasan el corte y se renderizan con el estado degradado en vez de la pantalla de error — el "tablero vacío indistinguible de *no hay trabajo*" que CA-8 quiere matar. El test `dashboard-config-invalida-viva.test.js` sólo cubre `/`.

---

### 🟡 Observaciones (no bloquean)

- `pulpo.js:1268-1269` — `pausaPreexistente` se calcula con `fs.existsSync(PAUSE_FILE)`, que no distingue el marker propio del ajeno. Desde el 2º ciclo de hot-reload (~30s) el copy pasa a `halt-preexistente` y le dice al operador que la pausa "no se levanta sola", cuando sí lo hará. El predicado correcto ya existe en el archivo: `partialPause.readFullPauseOrigin().source !== 'config-corruption-halt'` (`pulpo.js:1362`).
- `config-resolver.js:250-275` — `applyEnvOverrides` traza en **cada** `resolve()` sin el dedupe que sí tiene `traceOnce`. Con `reload:true` cada ~30s y un override activo son ~2.900-5.800 líneas/día en `pulpo.log`; además `traceLog` (`:159`) crece sin cota en un proceso de vida larga.
- `kernel-action-policy.js:137` y `operator-absence-policy.js:110` llaman `resolve()` **sin opts**, así que pasan a honrar `PIPELINE_STATE_DIR`/`PIPELINE_REPO_ROOT`, que su `pipelineDir()` local no honraba. Cambio de paridad real (CA-18) si esas env están seteadas; y ambos dejan `pipelineDir()` como código muerto.
- `pulpo.js:35` — `validateConfig` importado y sin uso. `pulpo.js:1346` — imprime `col null` cuando hay línea pero no columna.
- `kernel-parity.js:124` — el `require` del resolver pasó a ser eager; el original era lazy a propósito.
- **Scope**: el commit `b3863bfb` (credenciales de Drive → store externo, 6 archivos, +444) no pertenece a esta historia. Está bien hecho y con 15 tests verdes, y entiendo que destrabó la evidencia de QA de este mismo issue, pero conviene separarlo para que el revert de #5172 no arrastre un fix de credenciales no relacionado.

---

**Veredicto:** el diseño y la ejecución del resolver son sólidos y la mayor parte de los CA está cumplida con evidencia. Pero la historia existe para eliminar el fail-open silencioso, y en el camino introdujo uno en una acción de impacto `alto`. Corregido el punto bloqueante (+ los tres secundarios), esto se aprueba.
