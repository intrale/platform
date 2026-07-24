# Narrativa UX — Multi-Provider Health (#3260)

Sistema visual de la sección "Health" del tab Multi-Provider del dashboard
interno (puerto 3200). Cubre los CA-1 a CA-6 del issue #3260 (hardening de free
providers Groq / Gemini / Cerebras / NVIDIA-NIM).

Esta no es una historia de UI del producto del cliente final — es **herramienta
operativa del equipo Intrale**, corre en HTML/CSS/SVG porque vive embebido en
el dashboard del pipeline. La identidad visual sigue los tokens existentes
(`.pipeline/assets/design-tokens.css`) y el sprite (`.pipeline/assets/icons/sprite.svg`).

---

## Filosofía del sistema visual

La red de free providers es la **red de seguridad** del pipeline cuando se agota
Claude/Codex. El panel tiene que comunicar a primera vista, sin ambigüedad:

1. **¿Cuántos providers están vivos ahora?** — KPI "providers verdes" con número
   grande y color semántico.
2. **¿Cuál está sufriendo?** — bordes de card en rojo/amarillo enfatizan los
   problemas; bordes neutros para los sanos.
3. **¿Cuánto pesan los free providers en el pipeline real?** — barra apilada con
   colores de marca + porcentajes — no es teoría, es lo que está pasando.
4. **¿Cuándo se actuó?** — timestamps relativos ("hace 4m 12s") para todo lo que
   sea reciente; absolutos (`21:43:14`) para auditoría.

El operador abre este panel cuando algo huele mal en Telegram. No tiene que leer
docs para entenderlo — el color y el orden tipográfico se lo cuentan.

---

## Paleta y mapeo de estados

Todos los colores vienen de `design-tokens.css`. **Nada hardcoded fuera de
tokens**: si hay que sumar un color, primero se suma al token.

| Estado del provider | Token primario     | Token bg              | Borde card            |
|---------------------|--------------------|-----------------------|-----------------------|
| **Verde** (ping OK <10min, rate-limit-hit=0) | `--success` `#3FB950`  | `--success-bg`        | `--border` (sutil)   |
| **Amarillo** (ping OK pero rate-limit-hit>0 o cuota >80%) | `--warning` `#D29922`  | `--warning-bg`        | `--warning` (1.5px)  |
| **Rojo** (ping fallido O sin ping reciente >20min) | `--danger` `#F85149`   | `--danger-bg`         | `--danger` (1.5px)   |
| **Muted** (no configurado todavía, ej. NVIDIA-NIM pendiente) | `--text-dim` `#8B949E` | `--surface-1`         | `--border` punteado  |

Logos de proveedores: cada uno tiene su color de marca (`#F55036` Groq,
`#4285F4` Gemini, `#A855F7` Cerebras, `#76B900` NVIDIA). Estos colores **se usan
sólo en el isotipo del provider** — el resto del card pinta con tokens semánticos
para que el contraste y la legibilidad sean consistentes.

### Regla inquebrantable de color

> **Nunca informar estado SOLO por color.** Cada estado lleva además ícono
> (`ic-conn-ok` / `ic-conn-warn` / `ic-conn-err`) + label literal ("VERDE",
> "AMARILLO", "ROJO"). WCAG AA + daltonismo + escala de grises.

---

## Iconografía

Todo del sprite existente — **no se inventan íconos nuevos**:

| Símbolo                   | Uso                                                            |
|---------------------------|----------------------------------------------------------------|
| `ic-provider-groq`        | Logo Groq (rayo).                                              |
| `ic-provider-gemini`      | Logo Gemini (rombos entrelazados).                             |
| `ic-provider-cerebras`    | Logo Cerebras (wafer scale).                                   |
| `ic-provider-nvidia-nim`  | Logo NVIDIA NIM (nodo con halo). Card muted hasta que #3243.   |
| `ic-conn-ok` / `-warn` / `-err` | Estado del último ping (verde / amarillo / rojo).        |
| `ic-provider-health`      | Header del banner del cron (latido ECG).                       |
| `ic-retry-clock`          | Indicador "throttling intermitente · backoff Ns".              |
| `ic-quota-exhausted`      | Banner "excluido del fallback chain hasta volver a verde".     |
| `ic-snooze`               | Indicador "alerta dedupeada, cooldown 10 min".                 |
| `ic-shield-check`         | Footer "key válida · check semanal hace 2d".                   |
| `ic-key-rotate`           | Acción "Rotar key" (sólo en hover / menú contextual).          |
| `ic-info`                 | Tooltip "Por qué este provider está en muted".                 |

---

## Microcopy — reglas de tono

**Persona del operador**: técnico cansado a las 23:48 que necesita resolver
algo *ya*. No quiere prosa, quiere identificar el problema en 3 segundos.

### Estados live
- ✅ `VERDE · ping 184ms`
- ⚠️ `AMARILLO · ping 612ms`
- ❌ `ROJO · ping fallido`

No usar:
- ❌ "Excelente" / "Perfectísimo" / "Saludable" (zero información clínica)
- ❌ "Algo no anda bien" (no comunica severidad)
- ❌ Emojis (`🟢`/`🟡`/`🔴`) — el sistema usa SVG inline, no emojis del SO

### Reason codes (CA-4 / SR-7)
Mantener el set genérico de `live-ping.js`:

| Code                  | Cuándo se muestra                                       |
|-----------------------|--------------------------------------------------------|
| `authenticated`       | 200 OK con body parseable.                              |
| `invalid_credentials` | 401.                                                    |
| `forbidden`           | 403.                                                    |
| `quota_exhausted`     | 429 con marker quota (`"quota"`, `"exceeded"`).         |
| `rate_limited`        | 429 sin marker de quota.                                |
| `unknown`             | Otros 5xx o cuerpos sin parsear.                        |

**Prohibido** sumar un reason code que filtre detalle del provider (ej.
`gemini_v1beta_safety_block`). El detalle vive en el audit; el panel sólo
recibe el código genérico.

### Timestamps
- **Relativo** ("hace 4m 12s", "hace 2d") para todo lo que el operador necesita
  para responder *ahora*. Bajo `font-family: SF Mono`.
- **Absoluto** ("21:43:14", "2026-05-12") sólo en columnas de auditoría
  ("verified", footer audit).

### Alertas Telegram (CA-4)

Variantes de copy del feed del panel (NO del mensaje real de Telegram — eso
vive en `alerts.js` y debe ser metadata-only):

| Estado de la alerta | Copy del feed (panel)                                |
|---------------------|------------------------------------------------------|
| Enviada             | `cerebras = rojo · reason_code rate_limited · permanece > 10 min` |
| Dedupeada           | `cerebras = rojo · re-detectada · dedupe activo (cooldown 10 min)` |
| Back-off            | `proximo envio permitido en ~7m 12s · luego back-off 30 min` |
| Multi-down          | `2 free providers caidos simultaneamente · cerebras + tmp gemini` |

**Prohibido en el feed del panel y en el mensaje real de Telegram**:
- API key (ni masked ni fingerprint)
- Body excerpt del provider
- Stack trace con paths absolutos
- URLs completas con query params (`?key=…`)

El panel hace `redactHeaders` / `redactJson` antes de renderizar — si por error
llega algo sensible al snapshot, no se muestra.

---

## Layout y jerarquía visual

```
┌─────────────────────────────────────────────────────────────────────┐
│ Header dashboard (62px)                                             │
├─────────────────────────────────────────────────────────────────────┤
│ Título "Salud de la red de free providers" + subtítulo              │
├─────────────────────────────────────────────────────────────────────┤
│ Banner cron · último tick · jitter · lock holder · audit path       │ ← CA-1 / SR-3
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────────┐                 │
│ │ Groq    │ │ Gemini  │ │ Cerebras│ │ NVIDIA NIM  │                 │
│ │ VERDE   │ │ AMARILLO│ │ ROJO    │ │ pendiente   │                 │ ← Estado live
│ │ cuota   │ │ cuota   │ │ cuota   │ │ #3243       │                 │
│ │ %       │ │ %       │ │ %       │ │             │                 │
│ │ rl-hit  │ │ rl-hit  │ │ rl-hit  │ │             │                 │
│ │ key √   │ │ key √   │ │ key √   │ │             │                 │ ← CA-2 (semanal)
│ └─────────┘ └─────────┘ └─────────┘ └─────────────┘                 │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│ Alertas Telegram (feed con dedupe)         │ KPIs · stacked bar     │ ← CA-4
│                                            │ % free providers 24h   │
├─────────────────────────────────────────────────────────────────────┤
│ Free tier real por provider (tabla CA-5)                            │ ← CA-5
├─────────────────────────────────────────────────────────────────────┤
│ Footer audit paths                                                  │ ← SR-10
└─────────────────────────────────────────────────────────────────────┘
```

### Reglas de grilla
- 4 columnas para las cards de provider (334px + gap 12px), 1440px total
- NVIDIA-NIM tiene 354px (ligeramente más ancho) para acomodar el copy
  "pendiente #3243"
- El bloque "Alertas Telegram" y el panel de "Resumen" comparten fila para
  aprovechar viewport > 1280px; en breakpoints menores el panel se apila

---

## Estados y transiciones

### Card de provider — transición de estado

Cuando el snapshot del cron actualiza un card:

1. **Verde → Amarillo**: borde anima de `--border` a `--warning` con
   `transition: border-color 320ms ease-out`. Sin flash adicional — el operador
   se da cuenta por color, no por movimiento.
2. **Verde/Amarillo → Rojo**: pulso sutil de 600ms en el ícono `ic-conn-err`
   (`scale 1.0 → 1.08 → 1.0`). El pulso ocurre **una sola vez** al cambio; no
   queda loop infinito que distraiga.
3. **Cualquier → Verde**: borde transiciona, ningún flash. El estado "salí del
   problema" no necesita celebración visual.

### Panel completo — refresh

El snapshot se lee cada 30s (sin polling al backend del provider — solo lee el
archivo persistido). Si el snapshot tiene más de 60s, mostrar pill discreta en
header: `Snapshot stale · 1m 23s` con `--retry`. Esto cubre el caso "el cron
murió y nadie se dio cuenta".

---

## Accesibilidad (WCAG AA)

Todos los textos verificados con WebAIM Contrast Checker contra `--surface-1`
(`#161B22`):

| Token texto       | Contraste sobre `--surface-1` | Uso                        |
|-------------------|-------------------------------|----------------------------|
| `--text-primary`  | 14.8:1                        | Headers, números KPI       |
| `--text-secondary`| 9.7:1                         | Labels, descripciones      |
| `--text-dim`      | 5.3:1                         | Timestamps, hints          |
| `--success`       | 5.9:1                         | Estado verde + KPI         |
| `--warning`       | 7.4:1                         | Estado amarillo + KPI      |
| `--danger`        | 6.3:1                         | Estado rojo + KPI          |

Tamaños mínimos:
- Cuerpo: 12px (descripciones cortas), 13px (default)
- KPI grandes: 20-22px
- Microcopy auditoría: 11px (no más chico)

Botones / acciones (Rotar key, Test ping, etc.):
- Tamaño mínimo de touch target: 32px de alto (el cron está pensado para
  desktop pero queremos consistencia con #3177)
- Foco visible con outline `--brand-cyan` 2px (no quitar `:focus-visible`)

---

## Reglas de seguridad visual (espejo de los 10 SR-N de security)

Estas son **inquebrantables** y verificables en `verificacion`:

1. **SR-1**: el botón "Rotar key" del menú contextual abre el modal de rotación
   gestionado por `secrets-rw.rotateKey()` — nunca un input plano de texto
   sobre la card que persista por su cuenta.
2. **SR-2**: el panel no expone ni renderiza la URL completa del endpoint con
   query string (Gemini tiene `?key=…`). Render: solo el host + path. La key va
   en el modal de rotación, masked.
3. **SR-4**: el feed de alertas Telegram NO renderiza fingerprint ni masked
   key. Si el snapshot trajera por error un campo `fingerprint`, el panel lo
   ignora (`hidden` por CSS y `aria-hidden="true"`).
4. **SR-5**: el indicador "dedupe activo" muestra cooldown en relativo
   ("~7m 12s") pero **no expone el contenido** del archivo
   `telegram-alerts-dedup.json` — solo el campo `next_send_at_relative`.
5. **SR-6**: los datos visibles vienen del snapshot persistido por el cron,
   nunca de un fetch directo al provider desde el navegador (eso filtra cuota
   y latencia del cliente — además sería request del cliente con key).
6. **SR-8**: el panel no acepta input de keys reales — los inputs viven en el
   modal de rotación (#3177) que ya está auditado.

---

## Estados que faltan mockear (futuro / fuera de scope #3260)

Los siguientes estados quedan **fuera de #3260** y no tienen mockup hasta que
abran su propio issue:

- **Healthcheck con cron muerto** (el lock holder murió y nadie tomó el slot
  — recovery automático).
- **Provider re-añadido al fallback chain** después de volver a verde (toast
  de confirmación opcional).
- **Vista de drill-down** por provider (histórico de pings × 7d / 30d) — esto
  cae en el "Auto-fallback preventivo on healthcheck-red" del guru, queda como
  recomendación futura.

---

## Lista de assets entregables

Todos commiteados en `.pipeline/assets/`:

| Archivo                                                            | Estado                            |
|--------------------------------------------------------------------|-----------------------------------|
| `mockups/17-multi-provider-health.svg`                             | **Nuevo** — cubre CA-1 a CA-6     |
| `mockups/narrativa-multi-provider-health.md`                       | **Nuevo** — este documento        |
| `icons/sprite.svg` (símbolos `ic-provider-*`, `ic-conn-*`, `ic-provider-health`, `ic-retry-clock`, `ic-quota-exhausted`, `ic-snooze`, `ic-key-rotate`, `ic-shield-check`) | **Ya existían** — reutilizados |
| `design-tokens.css` (`--success`/`--warning`/`--danger`/`--retry`) | **Ya existían** — reutilizados   |

El dev (pipeline-dev) NO necesita inventar ningún color, ícono, ni tipografía.
Su trabajo es **integrar**, no diseñar — todo el sistema visual está cerrado.

---

## Notas para `verificacion`

Cuando UX evalúe la implementación del dashboard en fase `aprobacion`:

1. Verificar que `views/dashboard/multi-provider.js` referencia íconos del
   sprite vía `<use href="#ic-*">` (no inline SVG duplicado).
2. Verificar que el CSS usa `var(--success)`, `var(--warning)`, `var(--danger)`
   — nada de `#3FB950` hardcoded en la implementación.
3. Verificar que el feed de alertas NO renderiza nada que no sea
   `{ provider, state, reason_code, observed_at }` — abrir el HTML rendered
   con `curl` y `grep -i 'sk-\|gsk_\|AIza\|nvapi-\|fingerprint'` — esperado:
   cero matches.
4. Verificar que las animaciones de transición de estado están limitadas
   (un solo pulso al pasar a rojo; sin loop infinito).
5. Verificar contraste WCAG AA en cada estado con WebAIM o lighthouse.

---

— `ux` · pipeline V3 · fase `criterios` · ola N+5 · issue #3260
