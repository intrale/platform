# Modo descanso del pipeline

Doc del épico [#2882](https://github.com/intrale/platform/issues/2882). Esta
historia se entrega en 3 PRs independientemente mergeables:

- **PR-A (#2890)** — Modo descanso (gating horario + persistencia + UI básica).
- **PR-B (#2891)** — Hourly baseline + detector de anomalías de consumo.
- **PR-C** — Canales de alerta (Telegram + banner UI + snooze).

---

## Gating horario (PR-A)

Durante una ventana configurable, el pipeline **sólo** ejecuta los skills
**determinísticos** (`delivery`, `builder`, `linter`, `tester`). El resto de
skills (los que invocan al LLM: `po`, `ux`, `guru`, `security`, `planner`,
`qa`, `review`, `android-dev`, `backend-dev`, `web-dev`, `pipeline-dev`)
queda en `pendiente/` sin penalización (no consume rebote, no archiva).
Cuando la ventana cierra, el siguiente tick del pulpo los lanza respetando
los slots de concurrencia normales.

### Configuración

La configuración funcional vive en `.pipeline/rest-mode.json` y se edita
desde el dashboard (`/modo-descanso`) o vía `POST /api/rest-mode`:

```json
{
  "active": true,
  "start": "21:00",
  "end": "08:00",
  "timezone": "America/Argentina/Buenos_Aires",
  "days": [0, 1, 2, 3, 4, 5, 6],
  "manual": true,
  "updatedAt": "2026-05-04T22:30:00.000Z"
}
```

| Campo       | Tipo      | Descripción                                                            |
|-------------|-----------|------------------------------------------------------------------------|
| `active`    | bool      | Master switch. `false` → gate desactivado, pipeline opera sin restricciones. |
| `start`     | `HH:MM`   | Inicio de la ventana (formato 24h).                                    |
| `end`       | `HH:MM`   | Fin de la ventana. Si `end < start`, la ventana cruza medianoche.      |
| `timezone`  | string    | Zona IANA. Validada contra `Intl.supportedValuesOf('timeZone')` + alias engine. |
| `days`      | int[0..6] | Días activos. 0 = domingo, 1 = lunes, …, 6 = sábado (consistente con `Date.getDay`). |
| `manual`    | bool      | Marca si el usuario lo configuró manualmente desde la UI.              |
| `updatedAt` | ISO8601   | Última modificación (lo escribe el backend automáticamente).           |

El archivo se **escribe atómicamente** (`fs.writeFileSync(tmp)` →
`fs.renameSync(tmp, file)`) para que un crash en medio de la operación
no deje un JSON corrupto. Lectura y escritura son tolerantes: archivo
inexistente o corrupto → ventana inactiva (fail-open). El módulo NUNCA
detiene el pipeline.

### Bypass labels (config.yaml — read-only desde UI)

```yaml
rest_mode:
  bypass_labels:
    - "priority:critical"
  max_window_changes_per_hour: 30
```

Los issues con cualquiera de los `bypass_labels` ignoran el gate y arrancan
aun dentro de la ventana. La UI **no** edita esta lista (CA-Sec-A04a) —
agregar un label nuevo requiere abrir un PR sobre `config.yaml`, lo cual
pasa por CODEOWNERS.

### Integración en el pulpo

El gate vive en `pulpo.js::isIssueAllowed()` justo después de
`partialPause.isIssueAllowed`. Si el verdict es bloqueado, se loguea y se
hace `continue` sin tocar el archivo de pendiente:

```js
const restCfg = (loadConfig() || {}).rest_mode || {};
const verdict = restModeWindow.isSkillAllowedNow(skill, Date.now(), {
    cfg: restCfg,
    bypassLabels: issueLbls,
    pipelineDir: PIPELINE,
});
if (!verdict.allowed) {
    log('lanzamiento', `#${issue} skipped by rest-mode (skill=${skill}, reason=${verdict.reason})`);
    continue;
}
```

`reason` puede ser uno de: `outside_window`, `deterministic_skill`,
`bypass_label`, `within_window_non_deterministic` — útil para
diagnóstico desde el log.

### Hot-reload

No hay watcher: cada tick del pulpo lee el archivo fresco vía
`getWindow()`. Cualquier cambio guardado por el dashboard impacta en el
siguiente tick (~30s) sin reiniciar el pipeline (CA-3.3).

### Endpoints API

| Endpoint           | Método | Body                                                       | Auth      | Respuesta                                              |
|--------------------|--------|------------------------------------------------------------|-----------|--------------------------------------------------------|
| `/api/rest-mode`   | GET    | —                                                          | abierto   | `{ ok, window, bypassLabels, isWithinWindow, now }`     |
| `/api/rest-mode`   | POST   | `{ active, start, end, timezone, days, manual }`           | loopback  | `{ ok, state }` o `400 { ok:false, errors:[...] }`     |

- `POST` solo acepta loopback (`127.0.0.1` / `::1`) — desde otra IP
  responde `403` antes de parsear body (CA-Sec-A01).
- Body inválido: `400 { ok:false, errors:[<lista>] }`. Cada validación
  produce un error humano ("start debe ser HH:MM …", "timezone X no esta
  en Intl.supportedValuesOf('timeZone')", "days contiene valores fuera
  de [0..6]", etc.) — CA-Sec-A03.

### Audit trail (`.pipeline/rest-mode-audit.jsonl`)

Cada cambio se appendea con shape:

```json
{
  "ts": "2026-05-04T22:30:00.000Z",
  "actor": "api",
  "prev": { "active": false, "start": "21:00", "end": "08:00", "timezone": "...", "days": [0,1,2,3,4,5,6], "manual": false },
  "next": { "active": true,  "start": "21:00", "end": "08:00", "timezone": "...", "days": [0,1,2,3,4,5,6], "manual": true  }
}
```

`actor` puede ser `manual`, `api`, `cron`, `config-reload` o `init`. El
archivo crece append-only — no se rota en este PR (CA-Sec-A08). Si crece
mucho con el tiempo abrir un issue específico para rotar.

### UI

- **Pill en el header** (kiosk `/`): solo visible cuando `active=true`
  con start/end configurados. Texto: `🌙 Modo descanso · HH:MM-HH:MM ·
  ahora|programada`. Color indigo del token `--rest-mode` (UX #2896).
- **Tab "Modo descanso"** en la sidebar (`/modo-descanso`): form con
  toggle `active`, inputs `start`/`end`, datalist de timezones (poblada
  desde `Intl.supportedValuesOf('timeZone')`), checkboxes de días,
  botón guardar. Bloque de meta read-only con `bypass_labels` y
  `updatedAt`.

### Tests

- `lib/__tests__/rest-mode-window.test.js` — 28 tests (CA-5.1 +
  validaciones de seguridad).
- `lib/__tests__/rest-mode-window.integration.test.js` — 6 tests
  (CA-5.3, CA-5.4, CA-1.5, CA-1.9, CA-1.4 — escenarios end-to-end del
  gate emulando el composer del pulpo).

### Coexistencia con PR-C (cost-anomaly alert)

`.pipeline/rest-mode.json` es compartido: PR-A escribe los campos
`active/start/end/timezone/days/manual/updatedAt`, PR-C escribe el
campo `alert` (banner de consumo anómalo). Ambos módulos leen el
archivo entero y preservan los campos del otro al escribir. La regla
es "tocá solo lo tuyo" — explícito en el comment del header de cada
módulo.

---

## Detector de anomalías de consumo (PR-B)

El detector vigila el costo de la "hora actual" contra una **baseline horaria**
calculada sobre los últimos N días (rolling window, default 7, configurable
hasta 14). Cuando el costo actual supera el threshold relativo (`+50%` por
default) **y** el piso absoluto (`$0.50/h`), el detector emite un evento
interno `anomaly` y persiste la evaluación.

> **PR-B sólo persiste el histórico y emite eventos.** Los canales de alerta
> (Telegram, banner UI, snooze) llegan en PR-C. Hasta entonces el detector
> queda calibrando datos.

### Arquitectura

```
┌──────────────────────┐     metrics/snapshot.json     ┌──────────────────────┐
│ aggregator.js (cron) │ ─────────────────────────────▶ │ anomaly-detector.js  │
│   hourlySeries[HH]   │                                │  (cron interno 10m)  │
│   currentHour        │                                │  evaluate({ snap })  │
└──────────────────────┘                                └─────────┬────────────┘
                                                                  │
                                                                  ▼
                                          .pipeline/metrics-history.jsonl
                                          { type:'anomaly', ts, hour,
                                            baseline_usd, actual_usd,
                                            ratio, alerted }
```

- `aggregator.js` produce un snapshot cada 60s (default) con dos campos nuevos:
  - `hourlySeries["HH"]` — promedio cost_usd / tokens / sessions de la
    hora-del-día sobre los días dentro del lookback. Excluye el día actual.
  - `currentHour` — costo / tokens / sesiones acumulados en la hora-del-día
    en curso (UTC).
- `anomaly-detector.js` lee el snapshot, compara `currentHour.cost_usd` contra
  `hourlySeries[currentHour.hour].cost_usd * (1 + pctThreshold)` y persiste el
  resultado.

### Configuración (`.pipeline/config.yaml`)

```yaml
anomaly_detector:
  intervalMin: 10            # Cadencia del cron interno. Rango: [1, 240]
  pctThreshold: 0.5          # actual > baseline * (1+x). Rango: [0.05, 5.0]
  warmupDays: 7              # Grace period: sin baseline confiable durante N días
  lookbackDays: 7            # Días del rolling window. Rango: [7, 14]
  minUsdToAlert: 0.5         # Piso absoluto: si actual ≤ $0.50/h, no alerta
  minAbsUsdPerHour: 2.0      # Umbral grueso durante warmup (sin baseline)
```

Valores fuera de rango se reemplazan por defaults con warning en stderr — el
detector NUNCA detiene el pipeline por config rota.

### Lógica del detector

1. **Si estamos en warmup** (`daysWithData < warmupDays`):
   - Solo dispara si `actual > minAbsUsdPerHour` → `reason: warmup_absolute_breach`.
   - Caso contrario → `reason: warmup_within_absolute` (no alerta).
2. **Si actual ≤ minUsdToAlert**:
   - No alerta nunca → `reason: below_min_usd`.
   - Esto evita ruido en franjas vacías (ej. 3am sin actividad).
3. **Si actual > baseline × (1 + pctThreshold)**:
   - Alerta → `reason: relative_threshold_breach`.
4. **Caso contrario**:
   - No alerta → `reason: within_threshold`.

### Persistencia (`.pipeline/metrics-history.jsonl`)

Cada evaluación se appendea con shape:

```json
{
  "type": "anomaly",
  "ts": "2026-04-30T14:35:00.000Z",
  "hour": "14",
  "baseline_usd": 1.5,
  "actual_usd": 3.2,
  "ratio": 2.133,
  "alerted": true
}
```

> **Nota técnica**: el archivo `metrics-history.jsonl` es compartido con el
> snapshot de pulse del Pulpo (CPU/RAM/agentes). Los lectores existentes
> (`dashboard.js`, `rejection-report.js`, `pulpo.js::recordSkillResourceUsage`)
> filtran por presencia de `cpu`/`mem` numéricos para excluir entries de
> anomaly. La discriminación es `typeof s.cpu === 'number'`.

### Modo CLI

```bash
node .pipeline/anomaly-detector.js --once
node .pipeline/anomaly-detector.js --interval 5 --threshold 0.7
node .pipeline/anomaly-detector.js --warmup-days 3
```

Por defecto se inicia automáticamente desde `pulpo.js::mainLoop()` con un
`setInterval` interno. Si el constructor falla (config rota, archivo ausente,
etc.) el pulpo continúa corriendo: el detector es accesorio, no debe matar el
loop principal.

### Tests

```
.pipeline/tests/anomaly-detector.test.js              (18 tests)
.pipeline/metrics/__tests__/aggregator.test.js        (15 tests, 6 nuevos)
.pipeline/lib/__tests__/cost-anomaly-alert.test.js    (12 tests, PR-C)
.pipeline/lib/__tests__/rest-mode-state.test.js       (23 tests, PR-C)
```

Cubren CA-2.1 (hourlySeries shape), CA-2.2 (warmup grace period), CA-2.3
(intervalo configurable + clamp), CA-2.4 (threshold relativo + mínimo
absoluto), CA-2.5 (persistencia con shape canónico), CA-2.6 (formato del
mensaje Telegram), CA-2.7 (auto-clear con 2 chequeos consecutivos), CA-2.8
+ CA-Sec-A04b (snooze cap 24h), CA-5.5 (snapshot del payload sanitizado).

## Alertas de consumo anómalo (canales + snooze) — PR-C #2892

Cuando el detector dispara (`alerted: true`), el Pulpo enchufa dos canales
de alerta para que el operador se entere:

### Canal 1 — Telegram

El handler `pulpo.js::anomalyDetector.on('anomaly')` invoca
`lib/cost-anomaly-alert.js::sendTelegramAlert()`, que:

1. Lee el snapshot actual de `metrics/snapshot.json` para extraer top 3 skills.
2. Construye el mensaje en Markdown con el formato del mockup
   `assets/mockups/06-cost-anomaly-alert.svg`:

   ```
   ⚠ *Consumo anómalo detectado*
   Franja 14:00–15:00 · ratio +213%
   Actual: *$4.72 USD/h*
   Esperado: *$1.51 USD/h* (rolling 7d)

   *TOP 3 SKILLS*
   1. *android-dev* — $2.10 (44%)
   2. *backend-dev* — $1.34 (28%)
   3. *guru* — $0.78 (17%)

   → Ver detalle en el dashboard
   ```

3. **Sanitiza el payload** ANTES del envío (CA-Sec-A09):
   - `sanitizer.js::sanitize()` — reemplaza tokens (`sk-`, `ghp_`, `xoxb-`,
     AKIA, JWT, telegram bot tokens, AWS, paths absolutos `C:\...`) por
     placeholders `[REDACTED:<TIPO>]`. Maneja homoglifos y normaliza UTF-8.
   - `lib/redact.js::redactSensitive()` — enmascara emails y strippa
     userinfo de URLs.
   - Skill names se filtran con whitelist `^[a-zA-Z0-9_-]{1,40}$`. Skills
     que no matcheen se reemplazan por `[skill_invalid]`.

4. Encola el mensaje en `.pipeline/servicios/telegram/pendiente/` para que
   `svc-telegram` lo despache fire-and-forget. El servicio aplica
   `sanitizeTelegramPayload` una segunda vez como defensa final.

5. **Anti-spam**: solo se notifica la PRIMERA emisión de la racha. Si el
   detector sigue tickeando cada 10min con la misma anomalía,
   `restModeState.raiseAlert()` detecta `wasAlreadyActive` y devuelve
   `shouldNotify=false`. Solo después de un acuse manual o auto-clear
   se vuelve a notificar.

### Canal 2 — Banner persistente en dashboard

El estado vive en `.pipeline/rest-mode.json` (compartido con la ventana
de modo descanso de PR-A — campos coexisten):

```json
{
  "window_start": "21:00",          // (PR-A — modo descanso)
  "window_end": "08:00",            // (PR-A)
  "alert": {                        // (PR-C — alerta de consumo)
    "active": true,
    "raised_at": "2026-04-30T14:32:00.000Z",
    "hour": "14",
    "actual_usd": 4.72,
    "baseline_usd": 1.51,
    "ratio": 3.13,
    "top_skills": [
      { "skill": "android-dev", "cost_usd": 2.10, "share_pct": 44 },
      { "skill": "backend-dev", "cost_usd": 1.34, "share_pct": 28 },
      { "skill": "guru", "cost_usd": 0.78, "share_pct": 17 }
    ],
    "acked_at": null,
    "snoozed_until": null,
    "consecutive_baseline_checks": 0
  }
}
```

El dashboard lee `state.costAnomaly` y renderiza:

- **Pill compacta** en el header — `CONSUMO ANÓMALO · +213%` con el
  ícono `ic-cost-anomaly` (línea con pico). Pulsa suavemente. Al hacer
  click, scrollea al banner.
- **Banner persistente** (rosa-rojo, color token `--alert-anomaly`) con:
  - Headline + detalle (consumo actual vs esperado, franja, lookback).
  - Top 3 skills consumidores en chips.
  - Botón **"Ya lo vi"** (acuse manual → limpia estado).
  - Selector de snooze: 1h, 4h, **24h** (max destacado en indigo).

### Endpoints API (consume el frontend)

| Endpoint | Método | Body | Respuesta |
|---|---|---|---|
| `/api/cost-anomaly/state` | GET | — | `{ ok, state, visible, max_snooze_hours }` |
| `/api/cost-anomaly/ack` | POST | `{}` | `{ ok, acked, state }` |
| `/api/cost-anomaly/snooze` | POST | `{ hours: 1\|4\|24 }` | `{ ok, state }` o `422 { reason: 'exceeds_cap' }` |

### Snooze cap (CA-2.8 + CA-Sec-A04b)

- Cap fijo: **`MAX_SNOOZE_HOURS = 24`** — hardcoded en
  `lib/rest-mode-state.js`. NO es configurable desde `config.yaml`
  (un config malicioso no debe poder subirlo a 9999h).
- Backend valida en `snoozeAlert(hours)`: payloads con `hours > 24`
  devuelven `{ ok: false, reason: 'exceeds_cap', cap_hours: 24 }` con
  HTTP 422. NO se clampea silenciosamente.
- Auto-clear: cuando el detector emite 2 evaluaciones consecutivas con
  `alerted: false`, `recordBaselineCheck()` limpia la alerta sola
  (`CONSECUTIVE_BASELINE_CHECKS_TO_CLEAR = 2`, CA-2.7).
- "Ya lo vi" (`ackAlert`) limpia inmediatamente sin importar snooze
  ni contador.

### Tests específicos PR-C

El **snapshot del payload sanitizado** (CA-5.5 / CA-Sec-A09) está
committeado al test como `EXPECTED_SNAPSHOT` en
`lib/__tests__/cost-anomaly-alert.test.js`. Cualquier cambio al formato
debe actualizar el snapshot explícitamente — esa es la barrera contra
cambios accidentales que rompan el contrato de seguridad.

### Anti-patterns (importante)

- **NO** sumar nuevos canales de alerta sin pasar por `redactSensitive` +
  `sanitize`. La regla de oro es "no inventar lógica de sanitización".
- **NO** modificar `MAX_SNOOZE_HOURS` ni `CONSECUTIVE_BASELINE_CHECKS_TO_CLEAR`
  para "casos puntuales". Si surge una necesidad genuina, abrir un issue
  específico con justificación funcional + de seguridad.
- **NO** acoplar el banner a un `setTimeout` que lo cierre solo. La regla
  es: persistente hasta acuse manual / snooze expirado / auto-clear.
