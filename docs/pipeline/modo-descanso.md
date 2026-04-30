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
```

Cubren CA-2.1 (hourlySeries shape), CA-2.2 (warmup grace period), CA-2.3
(intervalo configurable + clamp), CA-2.4 (threshold relativo + mínimo absoluto)
y CA-2.5 (persistencia con shape canónico).

### Roadmap PR-C

- Engancha `detector.on('anomaly', ...)` para enviar Telegram via
  `servicios/telegram/`.
- Banner persistente en dashboard mientras `alerted=true` esté vigente.
- Snooze por hora (botón `/anomaly snooze 1h` desde Telegram).
- Sanitización del record antes de persistir (CA-2 seguridad PR-C).
