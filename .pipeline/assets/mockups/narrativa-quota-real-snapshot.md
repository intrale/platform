# Narrativa UX — Lectura precisa de cuota Claude desde cliente desktop (#3008)

> Brief de copy + guidelines visuales + script TTS para la captura
> automatizada del % real de cuota Anthropic desde el cliente Desktop.
>
> **Hijo de**: `narrativa-quota-exhausted.md` (#2955) — comparte tono, voz
> y restricciones de seguridad. Esta narrativa **agrega** los textos del
> dato real granular (6 buckets) sin reescribir lo de exhausted.
>
> **Importante**: la implementación (pipeline-dev) debe consumir estos
> copies tal cual están — cualquier desvío rompe la voz de Intrale
> (memoria `feedback_telegram-messages-natural`).

---

## 1. Filosofía del copy

**Tono**: directo, informativo, sin alarmismo. Los datos reales del cliente
Desktop son **información operativa** que ayuda al equipo a anticiparse al
agotamiento, no una alerta. Solo escalamos a tono "alerta" cuando se cruzan
umbrales (90% semanal) o cuando el parser falla.

**Voz**: Lili (asistente Intrale), tratamiento informal argentino. Coherente
con `narrativa-quota-exhausted.md` y `narrativa-modo-descanso.md` (#2882).

**Variación en alertas**: como las alertas críticas (parser offline, umbral
90%) son eventos infrecuentes pero importantes, **no** se rotan variantes —
una sola formulación clara por evento. Sólo los recordatorios periódicos
admiten variación.

**Restricciones de seguridad** (heredadas):
- CA-11 + CA-S7: prohibido interpolar input del usuario o contenido del PNG.
- CA-S3: todo mensaje pasa por `lib/redact.js` antes de enviarse.
- En alertas de error: **cero porcentajes, cero email, cero contenido**.
  Solo se interpola la **categoría** del error y el `ts`.

---

## 2. Sistema visual del banner expandido (delta vs banner #2992)

**El banner amarillo de "exhausted" (#2992) NO se reescribe**. Lo nuevo es
un **panel secundario** que aparece debajo del banner exhausted (cuando la
cuota está agotada) o como pill compacto en el header (cuando hay snapshot
fresco y la cuota NO está agotada).

### 2.1 Estados del banner real (4 estados, mockup `08-quota-real-snapshot-banner.svg`)

| Estado | Trigger | Borde | Pill | Fuente del dato |
|---|---|---|---|---|
| Snapshot fresco | `now - last_snapshot < TTL` (default 90 min) | `--success` (verde) | `DATO REAL · hace X min` (verde) | `.quota-history.jsonl` |
| Snapshot stale | `TTL < now - last_snapshot < 6h` | `--warning` (ámbar) | `SNAPSHOT STALE · X h Y min` (ámbar) | `.quota-history.jsonl` (último, opacado) |
| Sin snapshot | No hay archivo o `QUOTA_SNAPSHOT_ENABLED=false` | `--text-dim` (gris) | `ESTIMADO` (gris) | Heurístico `lib/weekly-quota.js` |
| Parser offline | `parse_fail_count >= 3` consecutivos | `--danger` (rojo) | `PARSER OFFLINE · 3 FALLOS` (rojo) | Última muestra válida + heurístico |

**Reglas inquebrantables**:
- **Cero información sólo por color**: cada estado tiene **borde + pill +
  microcopy + icono distintivo**. WCAG AA mínimo, AAA preferido.
- Tokens de color: usar **siempre** los semánticos de `design-tokens.css`
  (`--success`, `--warning`, `--danger`, `--text-dim`, `--quota-degraded`).
  Prohibido introducir hex hardcoded para esta feature.
- Tipografía numérica: `var(--in-mono)` (`'SF Mono', Consolas, monospace`)
  para todos los porcentajes, USD, countdowns y timestamps.

### 2.2 Jerarquía de los 6 buckets

Orden de izquierda a derecha (también para Telegram cuando se enumeran):

1. **Sesión actual** — el más urgente para Leo si está trabajando ahora.
2. **Semanal — Todos los modelos** — el bucket de mayor impacto operativo
   del pipeline.
3. **Semanal — Solo Sonnet** — segunda prioridad operativa.
4. **Semanal — Claude Design** — informativo, baja prioridad.
5. **Rutinas diarias (X/15)** — informativo, separado porque es cuenta entera.
6. **Overage API USD** — financiero, último.

**Justificación**: el orden refleja la frecuencia con la que cada bucket
**bloquea** el trabajo. Sesión y semanal-all son los que rompen el flow;
overage USD sólo importa al final del mes.

### 2.3 Microcopy de cada bucket (label + estado)

```
SESION ACTUAL                    [pct]%    Reset en X h Y min
SEMANAL — TODOS LOS MODELOS      [pct]%    [estado-segun-umbral]
SEMANAL — SOLO SONNET            [pct]%    [estado-segun-umbral]
SEMANAL — CLAUDE DESIGN          [pct]%    [estado-segun-umbral]
RUTINAS DIARIAS                  N/15      N disponibles hoy
OVERAGE API (USD)                $N / $M   [estado-segun-umbral]
```

**Estados textuales debajo del valor** (uno por línea, microcopy en español):
- `OK · debajo de 65%` (verde)
- `Atencion · supera 65%` (ámbar, equivale a `OK · uso medio`)
- `Critico · supera 90%` (rojo, gating activo)
- `OK · uso bajo` (verde, < 25%)
- `OK · sin overage activo` (verde, USD = $0)
- `OK · X disponibles hoy` (verde, rutinas)

### 2.4 Umbrales semánticos (umbral → color → microcopy)

Por bucket de tipo `*_pct`:

| Rango | Token | Microcopy |
|---|---|---|
| 0–24% | `--success` (verde) | `OK · uso bajo` |
| 25–64% | `--success` (verde) | `OK · uso normal` |
| 65–89% | `--warning` (ámbar) | `Atencion · supera 65%` |
| 90–100% | `--danger` (rojo) | `Critico · supera 90%` |

Por bucket especial:

| Bucket | Umbral verde | Umbral ámbar | Umbral rojo |
|---|---|---|---|
| `daily_routines_used / max` | 0–9 | 10–13 | 14–15 |
| `api_overage_used_usd / cap` | $0 (0%) | 1–80% | >80% |

**Configurable**: los umbrales viven en `lib/quota-thresholds.js`
(propuesta de implementación) o en una constante en `dashboard-slices.js`,
NO hardcoded en el render. Justificación: Leo puede querer ajustar el
umbral ámbar a 75% si prefiere más anticipación.

### 2.5 Indicador de frescura

Visible en el header del panel **siempre** que haya datos reales:

```
DATO REAL · SNAPSHOT HACE 12 MIN · 67% SEM
              ^^^^^^^^^^^^^^^^^^^^
              relative time del snapshot, microcopy variable:
              - "hace N seg"   (< 60 s)
              - "hace N min"   (< 60 min)
              - "hace N h Y min" (>= 60 min)
              - "hace N d Y h" (>= 24 h, sólo en stale extremo)
```

Cuando el banner exhausted está activo, el pill global del header del
panel real **NO** se muestra (para no saturar visualmente). El usuario
ve sólo el banner exhausted + el panel detallado de los 6 buckets.

### 2.6 Badge "DATO REAL" vs "ESTIMADO"

**Diferenciador inequívoco** entre fuente real y heurística. Pill con
icono distintivo:

- `DATO REAL` — icono ✓ (checkmark) verde, fondo `--success-bg`.
- `SNAPSHOT STALE` — icono reloj ámbar, fondo `--warning-bg`.
- `ESTIMADO` — icono ↑ (arrow up) gris, fondo neutro `--surface-1`.
- `PARSER OFFLINE` — icono ⚠ (exclamation circle) rojo, fondo `--danger-bg`.

**Posición**: arriba a la izquierda del panel, con la frescura textual a su
derecha. En el header global del dashboard también puede aparecer una
versión compacta cuando hay snapshot fresco y la cuota NO está agotada
(ver mockup, pill verde en línea con RUNNING).

---

## 3. Microcopy del comentario "/status" cuando hay snapshot

**Trigger**: usuario invoca `/status` desde Telegram con snapshot fresco.

```
Cuota Anthropic — dato real (hace 12 min):
- Sesion: 42% (reset en 3 h)
- Semanal: 67% todos / 52% Sonnet / 12% Design
- Rutinas: 3 / 15 hoy
- Overage: $0 / $50

Pipeline running. Determinisicos: 4. LLM: 7 corriendo.
```

**Sin emojis** (consistente con tono operativo del pipeline V3).
**Numerales** en cifras, sin separador de miles para los porcentajes.
**Orden** idéntico al del panel visual (jerarquía 2.2).

---

## 4. Mensajes Telegram — eventos nuevos del feature

### 4.1 Alerta umbral 90% semanal alcanzado (NUEVA — gate antes del 429)

**Trigger**: snapshot recién persistido reporta `weekly_all_models_pct >= 90`,
**y** el flag de exhausted aún no está seteado.

**Una sola variante** (es un evento distinguible y con acción concreta):

```
Cuota semanal al 90% segun snapshot real.
Pausando spawn de skills LLM para evitar 429.
Reset semanal estimado: <DIA> <FECHA> <HH:MM> (en X d Y h).
Determinisicos siguen procesando.
```

**Notas**:
- El umbral 90% es configurable (`QUOTA_SNAPSHOT_GATE_PCT`, default 90).
- El reset semanal se calcula desde `last_snapshot` + `session_minutes_to_reset`
  como upper bound (el cliente Desktop no expone reset semanal directo).
- **Una sola alerta** hasta que el flag se borre o el % baje del umbral.

### 4.2 Alerta parser offline (NUEVA)

**Trigger**: `parse_fail_count >= QUOTA_PARSE_FAIL_ALERT_THRESHOLD`
(default 3) consecutivos.

**Una sola variante**:

```
Lectura del cliente Claude Desktop fallo 3 veces seguidas.
Pipeline cae a heuristico para gates de cuota.
Causa probable: <categoria> (layout_drift | session_disconnected | account_mismatch | unknown).
Detalle en logs. Una sola alerta hasta que vuelva.
```

**Restricciones de seguridad** (CA-11 estricto):
- **NO se interpola** ningún `*_pct` ni `account_handle` ni timestamps específicos.
- Sólo se interpola la **categoría** del error (whitelist cerrada de strings).
- Anti-spam: **una sola alerta** hasta que el parse vuelva a funcionar
  (luego se puede emitir un `parser-restored` opcional si Leo lo pide).

### 4.3 Alerta cuenta no esperada (NUEVA)

**Trigger**: `account_handle` parseado ≠ `EXPECTED_CLAUDE_ACCOUNT` env var.

**Una sola variante**:

```
Snapshot capturado de una cuenta distinta a la esperada.
Descartado · no se contamina la calibracion.
Verifica login en Claude Desktop.
EXPECTED_CLAUDE_ACCOUNT no coincide con account_handle.
```

**Restricciones de seguridad**:
- **NO** se interpolan los emails (ni esperado ni real). El operador busca
  el detalle en `.pipeline/logs/quota-parser-*.log` si necesita debug.
- Una sola alerta hasta que coincida; al normalizarse no se notifica.

### 4.4 Recordatorio diario de % cuando supera umbral 65% (OPCIONAL)

**Trigger**: una vez al día (configurable hora), si
`weekly_all_models_pct >= 65` (umbral ámbar).

**4 variantes** (rota FIFO, anti-spam):

**Variante A — operacional**:
```
Cuota semanal al X% segun snapshot real.
Vamos en zona de atencion. Faltan N dias para el reset.
```

**Variante B — más informal**:
```
Heads-up: cuota semanal en X% real.
Zona ambar. Restan N dias para el reset.
```

**Variante C — corta**:
```
Cuota semanal X% (real). Reset en N dias.
```

**Variante D — con sugerencia**:
```
Cuota semanal en X% real.
Si no es prioritario, podes diferir lanzamientos pesados hasta el reset (N dias).
```

**Notas**:
- En este caso SÍ se interpola el porcentaje (es información operativa,
  no error). El % está clamped y validado antes de persistir (CA-5),
  por lo que es seguro.
- Hora default: 10:00 ART configurable (`QUOTA_DAILY_REMINDER_HOUR`).
- **OPCIONAL**: el feature base no requiere implementarlo; queda como
  recomendación independiente si Leo lo prefiere.

---

## 5. Script TTS — narración de Lili para audios opcionales

**Aplica sólo si Leo activa audios para alertas críticas** (no es default,
las alertas Telegram base son texto). Voz `es-AR-ElenaNeural` con `edge-tts`.

### 5.1 Audio de umbral 90% (alerta operativa)

```
Llegamos al noventa por ciento de cuota semanal real.
Pauso el lanzamiento de skills LLM hasta que ceda.
Falta <X dias y Y horas> para el reset.
Los deterministicos siguen avanzando como siempre.
```

### 5.2 Audio de parser offline (alerta diagnóstica)

```
La lectura del cliente Claude Desktop fallo tres veces seguidas.
Cae a heuristico para los gates.
Reviso el log y te aviso si vuelve a andar.
```

### 5.3 Audio de cuota restaurada cuando había estado cerca del 90%

```
Bajamos del umbral. Vuelvo a habilitar los skills LLM.
Cuota semanal real ahora en <pct> por ciento.
```

---

## 6. Handoff a implementación

**Tokens consumidos** (de `design-tokens.css`):
- `--success`, `--success-bg`, `--success-dim`
- `--warning`, `--warning-bg`, `--warning-dim`
- `--danger`, `--danger-bg`, `--danger-dim`
- `--text-primary`, `--text-secondary`, `--text-dim`
- `--quota-degraded` (heredado del banner exhausted, se mantiene)
- `--surface-0`, `--surface-1`, `--border`
- `--in-mono` (tipografía monoespaciada para datos numéricos)

**Componentes CSS reutilizados** (de la implementación del banner #2992):
- `.kpi-quota-dual`, `.kpi-quota-row`, `.kpi-quota-row-label`,
  `.kpi-quota-row-value`, `.kpi-quota-row-eta`
- `.kpi-quota-row.kpi-ok`, `.kpi-quota-row.kpi-warn`, `.kpi-quota-row.kpi-bad`

**Patrón de inserción**:
- El banner real-snapshot vive **debajo** del banner exhausted
  (`.quota-exhausted-banner`). Cuando exhausted está activo, ambos visibles.
- Cuando exhausted no está activo y hay snapshot fresco, sólo el banner
  real-snapshot visible (sin banner ámbar).
- Cuando ningún snapshot existe y la cuota no está agotada, **nada visible**
  en esta zona — comportamiento idéntico al pre-feature (CA-15).

**Mockup de referencia**:
- `.pipeline/assets/mockups/08-quota-real-snapshot-banner.svg`
- Resolución 1440×900, validado WCAG AA mínimo / AAA preferido.

**Sin íconos custom**: los íconos de los pills (✓, reloj, ↑, ⚠) se
implementan con SVG inline o con la familia ya en uso del dashboard
(`.kpi-icon`, ver `.pipeline/views/dashboard/home.js`).
