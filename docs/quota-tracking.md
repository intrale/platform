# Sistema de tracking de cuota Anthropic — pipeline V3

> Documentación end-to-end del sistema de captura, parse, persistencia,
> integración y presentación del consumo de cuota del Plan Max de Anthropic.
> Hijos de #3008 (split): #3012 captura/parse/persistencia, #3013 integración
> + UX. Issues relacionados: #2974 (detector binario de cuota agotada),
> #2975 (notificador Telegram), #2992 (banner heurístico actual).

---

## 1. Captura

La captura del % real de cuota se hace contra el cliente Claude Desktop
(no hay API pública de Anthropic para el Plan Max). El responsable es el
script PowerShell de #3012 (`.pipeline/services/quota-snapshot/capture.ps1`):

1. Foco en la ventana del cliente Desktop.
2. Apertura del panel de Settings → Usage.
3. Captura del PNG de la región del panel (sin contenido sensible fuera).
4. Cierre del panel (idempotente).

Cadencia configurable vía env var `QUOTA_SNAPSHOT_INTERVAL_MIN` (default
60 min). Documentación detallada del PS script vive en su propio módulo;
acá sólo nos interesa que **deja un PNG por captura** en
`.pipeline/.quota-snapshots/<ts>.png`.

---

## 2. Parse y persistencia

El parser (`lib/quota-snapshot-parser.js` del #3012) consume cada PNG y
extrae:

- `weekly_all_models_pct` — % cuota semanal todos los modelos.
- `weekly_sonnet_pct` — % cuota semanal Sonnet.
- `weekly_design_pct` — % cuota semanal Claude Design.
- `session_pct` — % cuota sesión rolling 5h.
- `session_minutes_to_reset` — minutos al reset de sesión (entero positivo).
- `daily_routines_used`, `daily_routines_max` — rutinas del día (X/15).
- `api_overage_used_usd`, `api_overage_cap_usd` — overage USD.
- `account_handle` — email del usuario logueado en Desktop.
- `parse_confidence` — float 0..1 con la confianza del OCR.
- `parse_warnings` — lista de strings (`layout_drift`, `account_unknown`, etc.).
- `ts` — timestamp ISO de la captura.

Cada snapshot válido se appendea como una línea JSON al archivo
**`.pipeline/.quota-history.jsonl`** (rotado por #3012 cuando supera tamaño
configurable). El JSONL es la fuente de verdad para el integrador (#3013).

El parser también mantiene un archivo de estado:
**`.pipeline/.quota-parser-state.json`** con:

```json
{
    "fail_count_consecutive": 3,
    "last_fail_at": "2026-05-06T...",
    "last_category": "layout_drift",
    "last_success_at": "2026-05-06T..."
}
```

Categorías permitidas (allowlist cerrada — cualquier otro valor se ignora
por R2/CA-S2): `layout_drift`, `tesseract_error`, `account_unknown`,
`shape_invalid`, `session_disconnected`, `account_mismatch`, `unknown`.

---

## 3. Integración con detector binario (#2974)

El módulo `lib/quota-snapshot-integration.js` (#3013) es el wire entre el
JSONL del #3012 y la infra existente. Su API pública:

### `evaluateSnapshotAndGate(snapshot, opts)`

Invocada por el scheduler del #3012 después de cada parse exitoso.
Defense-in-depth (R1, CA-S1):

1. Re-valida el shape del snapshot:
   - Pcts en `[0, 100]`, NaN/Infinity → reject.
   - `session_minutes_to_reset` en `(0, 10080]`.
   - `account_handle` no vacío.
   - `parse_confidence >= 0.8` (si está presente).
   - `parse_warnings` sin flags críticos (`layout_drift`, `account_unknown`,
     `shape_invalid`).
   - `ts` parseable, no en futuro, no más viejo que `QUOTA_BANNER_STALE_MAX_HOURS`.

2. Verifica `account_handle` contra `EXPECTED_CLAUDE_ACCOUNT` (case-insensitive).
   Si mismatch, descarta + emite alerta CA-UX-7 sin interpolar emails.

3. Si `weekly_all_models_pct >= QUOTA_SNAPSHOT_GATE_PCT` (default 90):
   - Llama `setFlag({ errorType: 'snapshot_threshold_90', resetsAt, agent: 'quota-snapshot-integration' })`
     del módulo `quota-exhausted.js` (CA-12, sin cambiar firma de `setFlag`).
   - El `errorType` se agregó a `DEFAULT_ERROR_TYPES` de `quota-exhausted.js`
     — única modificación al módulo binario, aditiva.
   - Anti-spam por ventana semanal (R4): una sola alerta Telegram por
     `last_weekly_reset`. Estado en `.quota-snapshot-integration-state.json`.

4. Llama `saveCalibration(metricsDir, obs)` del módulo `weekly-quota.js`
   con dato real (CA-13). El algoritmo EMA + sliding window de 20 muestras
   queda intacto — sólo cambia el origen del `obs` (manual via Telegram →
   automático del snapshot).

   **Importante**: la secuencia es `computeQuota()` ANTES → `saveCalibration()`
   DESPUÉS, para que el factor se calcule contra el `pct` heurístico **previo**
   a la calibración (de lo contrario el factor sale 1.0 y el EMA pierde
   precisión).

### `getBannerState(opts)`

Lectura pasiva para el dashboard (`/api/dash/quota-snapshot`). Devuelve
`{ state, ageMs, ttlMin, staleMaxHours, lastSnapshot, parserState }`.
Estados (narrativa §2.1):

- `'fresh'` — `now - last_snapshot.ts < QUOTA_BANNER_TTL_MIN`.
- `'stale'` — `TTL ≤ age < QUOTA_BANNER_STALE_MAX_HOURS`.
- `'missing'` — sin snapshot disponible o feature off.
- `'parser-offline'` — `fail_count_consecutive >= QUOTA_PARSER_FAIL_ALERT_THRESHOLD`.

`parser-offline` tiene prioridad visual incluso si hay snapshot fresco:
el dato puede estar fresh por suerte pero el parser está roto, hay que
avisar.

El snapshot devuelto pasa por `sanitizeSnapshotForOutput()` que elimina
`account_handle` (CA-S3, CA-S7). Sólo se exponen los pcts, contadores y
USD necesarios para el render.

---

## 4. Calibración EMA (cambio de origen, no de algoritmo)

El módulo `lib/weekly-quota.js::saveCalibration()` se mantiene **sin
modificación** (CA-13). El algoritmo:

- α = `max(0.2, 1/sqrt(n))` decreciente con muestras.
- Sliding window de 20 muestras.
- Detección de drift de TZ del weekly reset.

Lo único que cambia es **quién** invoca `saveCalibration()`:

- Antes (#2955): manualmente vía comando Telegram con valores reportados
  por el operador desde claude.ai.
- Ahora (#3013): automáticamente desde `evaluateSnapshotAndGate()` con
  `realWeeklyPct = snapshot.weekly_all_models_pct`,
  `realSessionPct = snapshot.session_pct`, etc.

Coexisten ambos flujos sin conflicto: `saveCalibration` es idempotente y
acumula muestras en el historial para EMA.

---

## 5. Banner #2992 con dato real (4 estados)

El banner real-snapshot (#3013) vive **debajo** del banner exhausted
(#2992 / #2974). CSS y HTML en `.pipeline/views/dashboard/home.js`:

- `.quota-snapshot-banner[data-state="missing"]` → `display:none`
  (cero render, comportamiento idéntico al pre-feature — CA-15).
- `.quota-snapshot-banner[data-state="fresh"]` → border-left verde,
  pill `DATO REAL · hace X min`, ícono ✓.
- `.quota-snapshot-banner[data-state="stale"]` → border-left ámbar,
  pill `SNAPSHOT STALE · X h Y min`, ícono ⏳.
- `.quota-snapshot-banner[data-state="parser-offline"]` → border-left rojo,
  pill `PARSER OFFLINE`, ícono ⚠.

Los 6 buckets se renderizan en orden fijo (narrativa §2.2):
sesión → semanal todos → semanal Sonnet → semanal Design → rutinas → overage.

WCAG AA mínimo: cada estado tiene **borde + pill + microcopy + ícono**
distintivos (cero reliance en color solo). CA-UX-9.

Tokens consumidos (todos en `.pipeline/assets/design-tokens.css`):
`--success`, `--success-bg`, `--warning`, `--warning-bg`, `--danger`,
`--danger-bg`, `--text-primary`, `--text-secondary`, `--text-dim`,
`--surface-0`, `--surface-1`, `--border`, `--in-mono`. Cero hex hardcoded.

---

## 6. Variables de entorno (configurabilidad completa)

| Variable | Default | Descripción |
|---|---|---|
| `QUOTA_SNAPSHOT_ENABLED` | `true` | Kill switch general. `false` deshabilita ambos wires (CA-S6). |
| `QUOTA_SNAPSHOT_GATE_ENABLED` | `true` | Kill switch granular del gate. `false` mantiene calibración + banner pero no gatea. |
| `QUOTA_SNAPSHOT_GATE_PCT` | `90` | Umbral del gate `setFlag('snapshot_threshold_90')`. |
| `QUOTA_BANNER_TTL_MIN` | `90` | Edad máxima del snapshot para considerarse `fresh`. |
| `QUOTA_BANNER_STALE_MAX_HOURS` | `6` | Edad máxima antes de degradar a `missing`. |
| `QUOTA_PARSER_FAIL_ALERT_THRESHOLD` | `3` | Fallos consecutivos del parser antes de marcar `parser-offline`. |
| `QUOTA_THRESHOLD_WEEKLY_AMBER` | `65` | Umbral ámbar bucket semanal-all (configurable por bucket). |
| `QUOTA_THRESHOLD_WEEKLY_RED` | `90` | Umbral rojo bucket semanal-all. |
| `QUOTA_THRESHOLD_SESSION_AMBER` / `_RED` | `65` / `90` | Umbrales bucket sesión. |
| `QUOTA_THRESHOLD_SONNET_AMBER` / `_RED` | `65` / `90` | Umbrales bucket Sonnet. |
| `QUOTA_THRESHOLD_DESIGN_AMBER` / `_RED` | `65` / `90` | Umbrales bucket Design. |
| `QUOTA_THRESHOLD_ROUTINES_AMBER` | `10` | Rutinas usadas para ámbar (default 10/15). |
| `QUOTA_THRESHOLD_ROUTINES_RED` | `14` | Rutinas usadas para rojo (default 14/15). |
| `QUOTA_THRESHOLD_OVERAGE_AMBER` | `1` | % overage USD para ámbar. |
| `QUOTA_THRESHOLD_OVERAGE_RED` | `80` | % overage USD para rojo. |
| `EXPECTED_CLAUDE_ACCOUNT` | (vacío) | Email esperado del cliente Desktop. Si vacío, no se valida (con warning). |
| `QUOTA_SNAPSHOT_INTERVAL_MIN` | `60` | (#3012) cadencia de captura en minutos. |
| `QUOTA_TZ_OFFSET_MIN` | `-180` | Offset de TZ para reset semanal (Argentina por default). |

Override de paths de tests:

- `PIPELINE_DIR_OVERRIDE` — override del `.pipeline/` para fixtures.
- `ACTIVITY_LOG_PATH` — override del activity log para tests del calibrador.

---

## 7. Política de retención

El JSONL `.quota-history.jsonl` se rota por #3012 cuando supera
`QUOTA_HISTORY_MAX_BYTES` (default 5 MB). El archivo activo siempre está
presente post-rotación; los archivos rotados van a `.pipeline/.quota-history-archive/`
con timestamp.

El archivo de integración `.quota-snapshot-integration-state.json` no
crece sin límite — sólo tiene 4 timestamps + 1 metadato de ventana
semanal. Se rotaría sólo si cambia el shape (versionado del archivo).

---

## 8. Kill switch

**`QUOTA_SNAPSHOT_ENABLED=false`** desactiva el sistema completo:

- `evaluateSnapshotAndGate()` → no-op (`{ ok: false, reason: 'kill_switch' }`).
- `getBannerState()` → `{ state: 'missing' }` (banner hidden).
- El `/status` no agrega el bloque snapshot (cae al formato heurístico).

Validable con:

```bash
QUOTA_SNAPSHOT_ENABLED=false node .pipeline/dashboard.js
# + reload del dashboard → banner real-snapshot hidden, estado idéntico al pre-feature.
```

**`QUOTA_SNAPSHOT_GATE_ENABLED=false`** desactiva sólo el gate (mantiene
calibración + banner). Útil cuando el gate empieza a generar pausas
sospechosas en producción y necesitamos aislar.

---

## 9. Sistema visual

Mockup de referencia: `.pipeline/assets/mockups/08-quota-real-snapshot-banner.svg`
(1440×900, 4 estados, WCAG AA mínimo / AAA preferido).

Narrativa completa (microcopy de los 6 buckets + 2 mensajes Telegram +
formato `/status`): `.pipeline/assets/mockups/narrativa-quota-real-snapshot.md`.

Identidad visual:

- Pill `DATO REAL` — fondo `--success-bg`, color `--success`, ícono ✓.
- Pill `SNAPSHOT STALE` — fondo `--warning-bg`, color `--warning`, ícono ⏳.
- Pill `ESTIMADO` — fondo neutro `--surface-1`, color `--text-dim`,
  ícono ↑ (no se renderiza visible cuando estado es `missing`).
- Pill `PARSER OFFLINE` — fondo `--danger-bg`, color `--danger`, ícono ⚠.

---

## 10. Troubleshooting

| Síntoma | Causa probable | Acción |
|---|---|---|
| Banner stuck en `STALE` por más de 6h | Script PowerShell no corre (Desktop cerrado, scheduler caído) | Verificar `Get-ScheduledTask` del job de captura; revisar `.pipeline/logs/quota-capture-*.log` |
| Banner alterna `STALE` ↔ `FRESH` rápido | Cadencia de captura cerca del TTL | Bajar `QUOTA_BANNER_TTL_MIN` o subir `QUOTA_SNAPSHOT_INTERVAL_MIN` para que TTL ≈ 1.5 × intervalo |
| Banner en `PARSER OFFLINE` | 3+ fallos consecutivos del OCR | Revisar `.pipeline/logs/quota-parser-*.log`. Categoría `layout_drift` = Anthropic cambió el panel; `tesseract_error` = problema de instalación del binario |
| `EMA descalibrado` (`pct` real muy lejos del heurístico) | Calibración contaminada por snapshot de cuenta no esperada | Verificar `EXPECTED_CLAUDE_ACCOUNT` env var; revisar `.quota-snapshot-integration-state.json` y `weekly-quota.json` calibrations |
| Gate dispara con `weekly_all_models_pct = 91%` pero claude.ai muestra 75% | Snapshot stale + dato del Desktop desactualizado | Cerrar y reabrir cliente Desktop para forzar refresh del panel; verificar `parse_confidence` del último snapshot |
| `/status` no muestra bloque snapshot pese a haber snapshot fresco | `QUOTA_SNAPSHOT_ENABLED=false` o módulo no carga | Verificar env var; revisar logs del cmdStatus en `.pipeline/logs/commander-*.log` |
| Race en lectura del JSONL durante rotación | Esperado durante segundos al rotar el archivo | Banner cae a `missing` brevemente y vuelve a `fresh` solo en el siguiente tick (R8). Cero crash. |
| Telegram alerta de `umbral 90%` no llega | Anti-spam (una por ventana semanal) o flag exhausted ya activo | Inspeccionar `.quota-snapshot-integration-state.json::last_gate_window_start`; el flag exhausted suprime la alerta nueva (CA-12) |
| Cuenta cambia (Leo loguea otra cuenta en Desktop) | `account_handle != EXPECTED_CLAUDE_ACCOUNT` | Snapshot descartado, alerta CA-UX-7 enviada (sin emails). Actualizar `EXPECTED_CLAUDE_ACCOUNT` o re-loguear la cuenta correcta |

---

## Referencias cruzadas

- Historia padre #3008 — split en #3012 (captura/parse) + #3013 (integración + UX).
- Detector binario #2974 — `lib/quota-exhausted.js` (sin breaking change, sólo allowlist extendida).
- Calibrador EMA #2955 — `lib/weekly-quota.js` (sin breaking change, cambio de origen).
- Banner exhausted #2992 — `views/dashboard/home.js` (banner real-snapshot vive debajo).
- Notificador Telegram #2975 — `lib/quota-notifier.js` (2 mensajes nuevos en CA-UX-7).

Recomendaciones independientes (issues separados):

- #3009 — cadencia escalonada de captura.
- #3010 — parser multimodal (Claude Vision) como fallback.
- #3011 — regresión real en lugar de EMA.
- #3048 — métrica de drift entre snapshot real y heurístico.
