# Modo descanso del pipeline

Doc del épico [#2882](https://github.com/intrale/platform/issues/2882). Esta
historia se entrega en 3 PRs independientemente mergeables:

- **PR-A (#2890)** — Modo descanso (gating horario + persistencia + UI básica).
- **PR-B (#2891)** — Hourly baseline + detector de anomalías de consumo (este).
- **PR-C** — Canales de alerta (Telegram + banner UI + snooze).

> **Esta versión del documento sólo cubre la sección de Detector de anomalías
> (PR-B).** PR-A integrará en este mismo archivo las secciones de gating
> horario, persistencia de `.pipeline/rest-mode.json` y la UI del modo descanso
> cuando se mergee.

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
