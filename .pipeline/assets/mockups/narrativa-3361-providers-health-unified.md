# Narrativa UX — Refactor "Continuidad del Pulpo" hacia ventana Providers (#3361)

> Sistema visual + guidelines para mover el card duplicado del home a la ventana
> Providers unificada, y corregir el mapeo de `reason_code` a semáforos.
>
> Issue: [#3361 — Rediseñar área 'Continuidad del Pulpo'](https://github.com/intrale/platform/issues/3361)
> CAs cubiertos por UX: **CA-3** (home limpio), **CA-4 a CA-6** (panel salud live),
> **CA-7 a CA-10** (clasificación corregida por provider), **CA-11** (fuente única).

---

## Filosofía del refactor

**Una sola fuente de verdad por dato.** Hoy hay dos lugares que muestran salud
de providers: el card "Continuidad del Pulpo" del home y la sección Health de
la ventana Providers. El operador (Leo) ve los mismos providers con
interpretaciones distintas — el home dice "amarillo" cuando el provider no
tiene key, la ventana dice "sin key configurada". Esa fricción **oculta
incidentes reales**: cuando un provider crítico se rompe de verdad, el ruido
visual previo ya entrenó al ojo a ignorar amarillos.

El refactor empuja todo el dato live a la ventana Providers, deja el home
limpio para KPIs + actividad, y formaliza el mapeo `reason_code → semáforo`
para que NUNCA más un provider sin key configurada aparezca como anomalía.

---

## Sistema visual aplicado — qué se reutiliza, qué se agrega

### Tokens — **cero tokens nuevos**

Todo lo necesario está en `design-tokens.css`:

| Necesidad                         | Token existente              |
|-----------------------------------|------------------------------|
| Verde live (authenticated)        | `--success` `#3FB950`        |
| Amarillo (quota_exhausted)        | `--warning` `#D29922`        |
| Naranja (forbidden)               | `--retry` `#F59E0B`          |
| Rojo (invalid_credentials, unknown)| `--danger` `#F85149`         |
| Neutro muted (no_key / no aplica) | `--text-dim` `#8B949E`       |
| Azul info (banners explicativos)  | `--info` `#58A6FF`           |
| Identidad provider                | `--provider-*` (3.c / 3.d)   |
| Surface cards/panels              | `--surface-1` `#161B22`      |

**Justificación de no sumar tokens**: el sistema cubre los 5 niveles semánticos
que necesita el panel (ok / muted / warn / urgent / danger). Agregar un token
"no aplica" propio sería redundante con `--text-dim`, que ya cumple WCAG AA
sobre surface-1 (5.3:1) y se viene usando para timestamps, hints y placeholders.

### Iconos — **cero íconos nuevos**

Todos del `sprite.svg`:

| Símbolo                | Uso                                                       |
|------------------------|-----------------------------------------------------------|
| `ic-conn-ok`           | Estado verde (authenticated).                             |
| `ic-conn-warn`         | Estados amarillo (quota_exhausted) y naranja (forbidden). |
| `ic-conn-err`          | Estados rojo (invalid_credentials, unknown).              |
| `ic-info`              | Badge "NO APLICA · sin API key" para Anthropic.           |
| `ic-provider-health`   | Header del bloque "Salud live · ping por provider".       |
| `ic-shield-check`      | Indicador de key rotada hace N días.                      |
| `ic-clock-stale`       | Staleness pill ("hace Xm Ys · cache 5 min").              |
| `ic-provider-*`        | Identidad visual de cada provider.                        |

---

## Mapeo canónico `reason_code → semáforo`

**Esta tabla es la definición autoritativa.** Cualquier interpretación distinta
en `live-ping.js`, `provider-health.js` o el frontend es un bug.

| `reason_code`           | Semáforo            | Color (token)        | Ícono           | Borde card             | Cuándo se muestra |
|-------------------------|---------------------|----------------------|-----------------|------------------------|-------------------|
| `authenticated`         | **VERDE**           | `--success`          | `ic-conn-ok`    | `rgba(63,185,80,0.45)` | 200 OK con body parseable de auth ok |
| `no_key_configured`     | **NEUTRO · MUTED**  | `--text-dim`         | `ic-info`       | `--text-dim` punteado  | Provider listado pero sin entrada en `credentials.json`. Ausencia esperada. |
| `invalid_credentials`   | **ROJO**            | `--danger`           | `ic-conn-err`   | `--danger` 1.5px       | 401 — key existe pero el provider la rechaza |
| `quota_exhausted`       | **AMARILLO**        | `--warning`          | `ic-conn-warn`  | `--warning` 1.5px      | 429 con marker `"quota"` / `"exceeded"` en body |
| `forbidden`             | **NARANJA**         | `--retry`            | `ic-conn-warn`  | `--retry` 1.5px        | 403 — permisos, región, modelo no habilitado |
| `unknown`               | **ROJO**            | `--danger`           | `ic-conn-err`   | `--danger` 1.5px       | 5xx, body sin parsear, timeout |

### Reglas inquebrantables del mapeo

1. **`no_key_configured` JAMÁS amarillo.** Es la causa raíz del bug reportado
   por Leo. Amarillo es para "algo anda mal" (quota), no para "no aplica".
2. **Cada estado lleva color + ícono + literal**, no solo color (WCAG AA +
   daltonismo + escala de grises).
3. **El borde de la card cambia color solo en estados accionables** (warn /
   urgent / danger). Verde usa borde suave porque no necesita captar
   atención; muted usa borde punteado para diferenciar de los demás sin
   competir con los semáforos urgentes.
4. **El semáforo del live NO se pisa con el estado de la key.** Ambas
   informaciones conviven: la key puede estar "presente · rotada hace 14d" y
   el ping live decir "ROJO · invalid_credentials" si el provider la revocó.
   Es información ortogonal.

---

## Tratamiento especial — Anthropic ("no aplica" declarativo)

### Problema raíz

Anthropic se autentica vía OAuth Max del CLI (`claude`), no por API key. La
sesión OAuth vive en el cliente (`~/.claude/.credentials.json` del SDK), no es
pingueable desde el navegador del dashboard. Hoy el endpoint live devuelve
`no_key_configured` para Anthropic y el frontend lo pinta amarillo →
confusión total: el provider está perfectamente operativo, pero la UI dice
"anomalía".

### Solución declarativa (NUNCA hardcodear el nombre en el frontend)

Agregar bandera en `agent-models.json`:

```json
"providers": {
  "anthropic": {
    "launcher": "claude",
    "model": "claude-opus-4-7",
    "auth_mode": "oauth",
    "display_in_health": "not_applicable",
    ...
  }
}
```

`provider-health.listConfiguredProviders()` consume el flag y emite un estado
sentinela específico para el frontend:

```json
{
  "id": "anthropic",
  "auth_mode": "oauth",
  "display_state": "not_applicable",
  "reason": "oauth_session_in_cli",
  "label": "OAuth Max · sin API key"
}
```

### Render visual

- **Card con borde punteado** color `--text-dim` (no compite con verde/rojo).
- **Badge** "NO APLICA · sin API key" con ícono `ic-info`.
- **Subtítulo** mono: `auth_mode: "oauth"` + hint "sesión vive en el CLI".
- **Sin pill de semáforo** — la ausencia es deliberada y visualmente clara.

### Por qué declarativo y no hardcoded

Si mañana sumamos un provider que también usa OAuth (Codex con login web,
Claude API por web app, etc.), el frontend NO debe cambiar. La regla vive en
`agent-models.json`. **Hardcodear `if (provider === 'anthropic')` en el JS es
prohibición explícita** del análisis de seguridad de este issue.

---

## Staleness pill (CA-6)

### Problema

El polling del frontend es 30s, pero el backend cachea ≥5min en
`provider-health.js`. El operador ve "hace 12s" en la UI y cree que el ping es
fresco — en realidad el dato puede tener hasta 5 minutos.

### Solución

Pill en el header del bloque que muestra **la edad real del snapshot**, no la
edad del fetch al endpoint:

```
┌──────────────────────────────────────────┐
│ 🕒 SNAPSHOT                              │
│    hace 2m 14s · cache backend 5 min     │
└──────────────────────────────────────────┘
```

### Reglas

- Timestamp relativo siempre (`hace Xm Ys`, `hace Xd`).
- Sub-texto fijo `cache backend 5 min` para que Leo no se pregunte por qué a
  veces marca "hace 4m".
- **Si la edad > 5 min** (cache vencido sin refresh): la pill cambia a
  `--warning` y agrega un sub-texto `refresh pendiente`. Esto cubre el caso
  "el backend cron murió y nadie se dio cuenta".
- Tipografía: SF Mono / tabular-nums para que el timestamp no tiemble al
  re-renderizar.

---

## Layout y jerarquía visual

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Header dashboard (62px) · pestañas (Home / Providers ◉ / Consumo / ...) │
├─────────────────────────────────────────────────────────────────────────┤
│ Título "Salud de Providers · Vista unificada"        [Staleness pill]   │
├─────────────────────────────────────────────────────────────────────────┤
│ Banner "Fuente canónica · listConfiguredProviders()" (CA-11)            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│ BLOQUE 1 — CREDENCIALES · ESTADO DE KEYS (existente, sin tocar)         │
│   filas con accent --provider-* · masked key · key rotada hace N días   │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│ BLOQUE 2 — SALUD LIVE · PING POR PROVIDER (NUEVO — reemplaza home card) │
│   Resumen KPIs (verdes / muted / amarillos / rojos)                     │
│   Grid 4 cards:                                                         │
│     ┌Anthropic┐ ┌OpenAI ┐ ┌Gemini ┐ ┌Cerebras┐                          │
│     │NO APLICA│ │VERDE  │ │VERDE  │ │VERDE   │                          │
│     │OAuth Max│ │184ms  │ │212ms  │ │96ms    │                          │
│     └─────────┘ └───────┘ └───────┘ └────────┘                          │
│   Nota "groq removido (#3353)" + ElevenLabs (multimedia · separado)     │
├─────────────────────────────────────────────────────────────────────────┤
│ BLOQUE 3 — LEYENDA · MAPEO reason_code → semáforo                       │
│   6 chips horizontales con color + ícono + literal                      │
├─────────────────────────────────────────────────────────────────────────┤
│ BLOQUE 4 — HOME · ANTES vs DESPUÉS (referencia, no parte de la UI live) │
│   side-by-side mostrando que el home queda sin el card                  │
└─────────────────────────────────────────────────────────────────────────┘
```

### Grilla

- Viewport base 1440px, padding 32px, ancho útil 1376px.
- 4 cards de provider × 335px + 3 gaps × 12px = 1349px (alcanza con margen).
- Card height fija 140px (header + badge + reason mono + cache age).
- Breakpoint < 1280px: las 4 cards se reorganizan en grid 2×2.

---

## Microcopy — reglas de tono

**Persona del operador**: Leo a las 23:48 abriendo el dashboard porque algo
huele mal en Telegram. Necesita ver de qué provider es el problema en
**< 3 segundos**.

### Texto de cada estado

| Estado                 | Copy visible                                  |
|------------------------|-----------------------------------------------|
| `authenticated`        | `VERDE · 184ms`                               |
| `no_key_configured`    | `SIN KEY · no aplica`                         |
| `invalid_credentials`  | `ROJO · key inválida`                         |
| `quota_exhausted`      | `AMARILLO · cuota agotada (resets en 4d 02h)` |
| `forbidden`            | `NARANJA · permisos / región`                 |
| `unknown`              | `ROJO · sin parsear (5xx)`                    |

**Prohibido**:
- Emojis del SO (`🟢`/`🟡`/`🔴`) — el sistema usa SVG inline del sprite, no
  emojis renderizados por el SO (varían entre Windows / macOS / Linux y
  rompen consistencia + accesibilidad).
- Frases vagas tipo "Excelente" / "Algo no anda bien" — comunican cero
  severidad clínica.
- Exposición de `bodyExcerpt` en la UI (heredado de SR-3 de security).
- URLs con `?key=…` visibles (SR-2).

### Timestamps

- **Relativo** (`hace 4m 12s`, `hace 2d`) para todo lo que el operador
  necesita para responder ahora.
- **Absoluto** (`21:43:14`, `2026-05-12`) solo en footers de auditoría.

---

## Accesibilidad — WCAG AA (verificación)

Todos los pares verificados contra `--surface-1` (`#161B22`):

| Token texto       | Ratio | Nivel              | Uso                                |
|-------------------|-------|--------------------|------------------------------------|
| `--text-primary`  | 14.8:1| AAA                | Headers, números KPI               |
| `--text-secondary`| 9.7:1 | AAA                | Labels, subtítulos                 |
| `--text-dim`      | 5.3:1 | AA Normal          | Timestamps, hints, badge muted     |
| `--success`       | 5.9:1 | AA Normal          | VERDE + KPI verde                  |
| `--warning`       | 7.4:1 | AAA Large + AA Norm| AMARILLO + KPI amarillo            |
| `--danger`        | 6.3:1 | AA Normal          | ROJO + KPI rojo                    |
| `--retry`         | 6.7:1 | AA Normal          | NARANJA                            |
| `--info`          | 7.9:1 | AAA Large + AA Norm| Banners explicativos               |

Tamaños:
- Cuerpo 11-12px (descripciones, microcopy).
- Headers de bloque 14px.
- Números KPI 22px.
- Microcopy auditoría min 10px.

`prefers-reduced-motion`: no animar pulse al cambio de estado (single
transition `border-color 320ms ease-out` ok; sin loops).

---

## Reglas de seguridad visuales (heredadas de los SR-N del security agent)

Estas son **inquebrantables** y verificables en `verificacion`:

1. **SR-A03 XSS**: TODOS los campos interpolados (`id`, `reason`, `state`,
   `cache_age_s`, `label`) usan `escapeHtml()` en `multi-provider.js` o
   `textContent` puro. **Prohibido** `innerHTML` con interpolación raw.
2. **SR-A02 Data exposure**: el panel NO renderiza `bodyExcerpt` ni nada
   distinto al set `{ provider, state, reason_code, observed_at, cache_age_s,
   latency_ms }`. Si el snapshot llega con un campo nuevo no whitelist, no se
   muestra.
3. **SR-A06 SSRF**: ningún fetch al provider desde el navegador. La UI lee
   exclusivamente el snapshot persistido por el backend (`/api/pulpo/provider-health`).
4. **SR-A05 Rate limit**: la UI respeta el polling de 30s; un click en una
   card NO dispara un ping sintético adicional (eso vive en el botón "Ping"
   del bloque de keys, ya rate-limited 6 req/min).
5. **SR Secrets**: el dashboard nunca muestra `api_key`/`token`/`password` ni
   en attributes (`data-*`) ni en text content. La key solo aparece masked en
   el bloque de credenciales existente.

---

## Tests UX-side (criterios para `verificacion`)

Estos son los chequeos que UX validará cuando le toque revisar la
implementación en fase `aprobacion`:

1. **CA-1, CA-2** — `grep -rn "pulpoContinuidad\|Continuidad del Pulpo\|tickPulpoContinuidad" .pipeline/views/dashboard/home.js` → **0 matches**.
2. **CA-3** — Screenshot del home antes/después del refactor. Sin huecos
   visuales, sin layout shift detectable.
3. **CA-4** — Ventana Providers tiene la sección "Salud Live" con los 5
   estados representables visualmente.
4. **CA-5** — `grep -n "innerHTML\|escapeHtml" .pipeline/views/dashboard/multi-provider.js`
   → todas las interpolaciones de campos del response están escapadas.
5. **CA-6** — Staleness pill visible. Si tocamos `provider-health.json` para
   forzar age > 5min, la pill cambia a `--warning` y el texto suma "refresh
   pendiente".
6. **CA-7** — Anthropic aparece como NO APLICA con borde punteado muted, NO
   amarillo. Verificación: `agent-models.json` tiene `auth_mode: "oauth"` y
   la card del frontend renderiza el badge `ic-info` + literal.
7. **CA-8** — Con OpenAI key válida, la card renderiza VERDE con `reason:
   authenticated`.
8. **CA-9** — ElevenLabs (si se mantiene) aparece como bloque multimedia
   separado, no mezclado con los semáforos LLM.
9. **CA-10** — `grep -n "groq" .pipeline/lib/multi-provider/live-ping.js` →
   0 matches (cubierto por #3353).
10. **CA-11** — Ambos endpoints `/api/pulpo/provider-health` y
    `/api/multi-provider/health` devuelven exactamente el mismo set de
    provider IDs.

---

## Out of scope (qué NO entrega UX en este issue)

- Implementación JS del `renderProvidersHealthLive()` en `multi-provider.js`
  → `pipeline-dev`.
- Cambios en `live-ping.js` para emitir reason codes correctos → `pipeline-dev`.
- Bandera declarativa en `agent-models.json` → `pipeline-dev` (UX lo
  especifica como contrato).
- Limpieza de `home.js` (CSS + JS) → `pipeline-dev`.
- Decisión final ElevenLabs mantener / remover → coordinada con security en
  PR (UX prefiere mantener si TTS lo usa).
- Tests automatizados de reason codes (`live-ping-reason-codes.test.js`) →
  `tester`.

---

## Lista de assets entregables (#3361)

Todos commiteados en `.pipeline/assets/`:

| Archivo                                                              | Estado                            |
|----------------------------------------------------------------------|-----------------------------------|
| `mockups/18-providers-tab-with-integrated-health.svg`                | **Nuevo** — cubre CA-3 a CA-11    |
| `mockups/narrativa-3361-providers-health-unified.md`                 | **Nuevo** — este documento        |
| `mockups/16-continuidad-pulpo-card.svg`                              | Mantenido — referencia histórica  |
| `mockups/narrativa-continuidad-pulpo.md`                             | Mantenido — referencia histórica  |
| `mockups/17-multi-provider-health.svg`                               | Mantenido — sección cron (#3260)  |
| `icons/sprite.svg`                                                   | **Sin cambios** — todo reutilizado|
| `design-tokens.css`                                                  | **Sin cambios** — todo reutilizado|

El dev (`pipeline-dev`) NO necesita inventar ningún color, ícono ni
tipografía. Su trabajo es **integrar y mover**, no diseñar.

---

## Notas para `verificacion` (futuro yo, fase aprobacion)

Cuando UX evalúe la implementación, además del PASO 0.A (este issue es
`area:pipeline` + `tipo:infra` sin ningún `app:*` → **no exige video QA**,
aplica PASO 2-bis):

1. Verificar que `home.js` no contiene rastro del card (CA-1, CA-2).
2. Verificar render real del bloque Salud Live con `curl http://localhost:3200/v3/providers`
   y `grep -c "ic-conn-ok\|ic-info\|ic-conn-warn\|ic-conn-err"` para
   confirmar que los íconos del sprite están referenciados.
3. Verificar que ningún color está hardcoded fuera de tokens
   (`grep -nE "#[0-9A-Fa-f]{6}" .pipeline/views/dashboard/multi-provider.js`
   debería retornar solo fallbacks dentro de `var(--token, #hex)`).
4. Verificar que `agent-models.json` tiene la bandera declarativa para
   Anthropic.
5. Verificar que `escapeHtml()` cubre todos los campos interpolados.
6. Validar contrastes con DevTools → Accessibility en cada card.

---

**Autor**: UX (skill agente pipeline V3)
**Fecha**: 2026-05-18
**Issue**: #3361
**Ola**: post-N+5 (refactor del refactor del Pulpo)
**Dependencia bloqueante**: #3353 (remoción de Groq de live-ping.js)
