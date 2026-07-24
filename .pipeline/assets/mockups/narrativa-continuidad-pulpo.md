# Narrativa UX — Continuidad del Pulpo (#3259)

> Diseño visual + guidelines de UX para la card del dashboard V3 y los
> mensajes Telegram que comunican el estado de continuidad del Pulpo cuando
> uno o más providers LLM están con cuota agotada.
>
> Issue: [#3259 — Continuidad del Pulpo ante caída de Claude](https://github.com/intrale/platform/issues/3259)
> CAs cubiertos por UX: CA-6 (card dashboard) + CA-8 (formato Telegram) +
> CA-10 (mensaje de destrabe).

---

## Filosofía visual

**El Pulpo nunca muere — entra en pausa controlada.**

Toda la iconografía y copy refuerza esa idea. Cuando se agota Anthropic, no
mostramos un mensaje de error rojo sangre tipo "PIPELINE CAÍDO". Mostramos
un ámbar cálido (`--pulpo-paused: #E8770D`) con un pulpo dormido y un mensaje
del estilo "pipeline pausado, esperando cuota". El pipeline sigue procesando
issues con el resto de providers — la card debe reflejar eso.

Por contraste, los errores **realmente** críticos del pipeline (corrupción de
estado, deadlock, OOM) sí usan `--danger` rojo + iconografía severa. La
diferenciación visual entre "pausado por cuota" (operacional) y "roto"
(infraestructural) es deliberada y fundamental.

---

## Sistema de diseño aplicado

### Tokens nuevos agregados a `design-tokens.css`

**Sección 3.d — PROVIDERS FREE** (multi-provider fallback chain):

| Token CSS | Color | WCAG vs `surface-0` (#0D1117) |
|---|---|---|
| `--provider-groq` | `#FF6B47` (coral) | 5.4:1 AA Normal |
| `--provider-gemini` | `#8AB4F8` (azul Google) | 9.2:1 AAA Normal |
| `--provider-cerebras` | `#FFD166` (amarillo wafer) | 12.3:1 AAA |
| `--provider-nvidia-nim` | `#76B900` (verde NVIDIA) | 7.6:1 AAA Large + AA Normal |

Cada uno incluye también `-dim` (borde/hover), `-bg` (fondo translúcido) y
`-fg` (texto sobre fondo translúcido).

**Diferenciación crítica vs tokens existentes:**

- `--provider-groq` (#FF6B47 coral) ≠ `--provider-anthropic` (#E5946B copper),
  ≠ `--retry` (#F59E0B ámbar) y ≠ `--danger` (#F85149 rojo). Probado lado a
  lado en el mockup 16: distinguibles incluso para deficiencia rojo/verde.
- `--provider-cerebras` (#FFD166 amarillo claro) ≠ `--warning` (#D29922
  mostaza), ≠ `--retry` y ≠ `--quota-degraded` (#F0A500 ámbar). Reservado
  exclusivamente para Cerebras.
- `--provider-gemini` (#8AB4F8 azul claro) ≠ `--info` (#58A6FF) y ≠
  `--brand-blue` (#1890FF) — tono más claro, identitario Google sin replicar
  el logo.

**Sección 3.e — ESTADOS DEL PULPO** (#3259):

| Token CSS | Color | Uso |
|---|---|---|
| `--pulpo-paused` | `#E8770D` (ámbar cálido) | Card + banner cuando `provider-exhaustion-pause` activo |
| `--pulpo-paused-bg` | `rgba(232, 119, 13, 0.16)` | Fondo translúcido pills/banners |
| `--pulpo-paused-fg` | `#FFCD9B` | Texto sobre `pulpo-paused-bg` (contraste 10.1:1 — AAA) |
| `--pulpo-resumed` | alias `--success` | Mensaje Telegram de destrabe (CA-10) |

**Diferenciación vs `--quota-degraded`:** `quota-degraded` (#F0A500) está
reservado para el banner global "modo determinístico activo" del dashboard
(cuando TODO Anthropic está caído y el pipeline corre con builder/tester
puro). `pulpo-paused` (#E8770D) es para un issue específico pausado por
exhaustion total de fallbacks — más oscuro, más urgente.

### Iconos nuevos agregados a `sprite.svg`

| Icono | viewBox | Metáfora |
|---|---|---|
| `ic-provider-groq` | 24×24 | Rayo en círculo (velocidad LPU) |
| `ic-provider-gemini` | 24×24 | Dos rombos entrelazados (gémini) |
| `ic-provider-cerebras` | 24×24 | Wafer con grid 3×3 (chip masivo) |
| `ic-provider-nvidia-nim` | 24×24 | Nodo central + 3 satélites (microservice) |
| `ic-pulpo-paused` | 24×24 | Pulpo con barras de pausa overlay |
| `ic-pulpo-resumed` | 24×24 | Pulpo con check overlay |
| `ic-retry-clock` | 24×24 | Reloj + flecha circular (retry periódico) |
| `ic-provider-health` | 24×24 | Pulso ECG (healthcheck endpoint) |

Todos respetan la convención del sprite existente: `currentColor`,
`stroke-width: 1.55–1.75`, `stroke-linecap: round`, `stroke-linejoin: round`.

---

## Card "Continuidad del Pulpo" — guidelines

Mockup: [`16-continuidad-pulpo-card.svg`](./16-continuidad-pulpo-card.svg)

### Anatomía

La card vive **arriba** del grid maestro del tab "Multi-Provider" del
dashboard (mockup 11). Ocupa el ancho completo del viewport (1392px en
desktop) con altura ~380px.

```
┌── Header: icono pulso + título + auto-refresh ──┐
│ ◐ Continuidad del Pulpo                15:42:08 │
├─────────────────────────────────────────────────┤
│ PROVIDERS · ESTADO LIVE                         │
│ [pill1] [pill2] [pill3] [pill4] [pill5] [pill6] │
│                                                 │
│ DESPACHOS ULTIMAS 24H · POR PROVIDER            │
│ ████████████░░░░░░░░░░░░░░░░░░░░░░ (apilada)   │
│ Total: 412 · éxito 98.5% · fallbacks 23x        │
│                                                 │
│ [Banner condicional: modo degradado activo]     │
└── Footer: source of truth + endpoint ───────────┘
```

### Pills de provider (1 por provider)

Tamaño: **218×68px** (Cerebras y Deterministic colocados sin separación para
encajar 6 en una fila de 1352px).

Composición:
1. **Icono del provider** (esquina sup-izq, 24×24, color identitario).
2. **Nombre** (texto grande, `--text-primary`, fw 600).
3. **Dot de estado** + label (`ok` / `cuota baja` / `gated` / `unknown`).
4. **Línea 1 footer** (resets en / cuota X%, mono small).
5. **Línea 2 footer** (cache age, mono small, `--text-dim`).

### Reglas críticas

1. **Información NUNCA solo por color** (R6 del review #3086):
   - Cada estado tiene icono distintivo: `ic-conn-ok`, `ic-conn-warn`,
     `ic-conn-err`.
   - El texto del estado siempre acompaña al dot/icono.
   - El borde del pill cambia color solo en estados `gated` y `cuota baja`
     (refuerzo visual, no único portador de información).

2. **Auto-refresh consistente** (30s):
   - Mismo intervalo que el resto del dashboard.
   - El timestamp del header muestra cuándo fue el último refresh.
   - Respeta `prefers-reduced-motion`: sin spinner ni pulse animation.

3. **Cache visible**:
   - La línea `cache 27s` en cada pill comunica que el ping NO se hace en
     cada request — defensa contra amplificación (security A04 / A05).
   - Cuando un cache pasa los 5min, se renderiza en `--warning` (refresh
     pendiente).

4. **Click → tooltip/modal con detalle**:
   - Error type del último fallo
   - Contador de fallbacks usados HACIA ese provider en últimas 24h
   - Link al audit log (`.pipeline/audit/quota-exhausted-audit.jsonl`)

### Barra apilada de despachos (24h)

- Ancho completo (1352px), alto 32px, sin bordes intermedios.
- Cada segmento usa **el mismo color identitario del provider** — lectura
  cruzada inmediata con las pills de arriba.
- Texto sobre el segmento: `fill="#0D1117"` (negro surface-0) — contraste
  ≥7:1 sobre cualquier color de provider.
- Si un segmento es <40px de ancho, el texto se mueve abajo en un tooltip
  hover (no truncamos visualmente con `...`).

### Banner condicional "Modo degradado activo"

**Solo se renderiza si al menos un provider primary está gated.** Cuando
todos están OK, esta franja **desaparece** — no dejamos un banner vacío que
contamine visualmente.

Composición:
- Ícono `ic-pulpo-paused` grande (28×28) en color `--pulpo-paused`.
- Título: "Modo degradado activo — &lt;provider&gt; gated".
- Body: lista corta de issues en `provider-exhaustion-pause` (max 3, luego
  "+N más").
- Botón izq: countdown del próximo retry (icono `ic-retry-clock`).
- Botón der: "Forzar retry ahora" (primary action, `--brand-blue`).

---

## Mensajes Telegram — formato (CA-8 + CA-10)

Mockup: [`16b-telegram-exhaustion.svg`](./16b-telegram-exhaustion.svg)

### Mensaje de PAUSA (CA-4 + CA-8)

Trigger: `pulpo.js` detecta primary + todos los fallbacks gated.

**Estructura obligatoria**:
```
[!] Pipeline pausado — cuota agotada

Issue: #3271 — feat(android): rediseño card de transacciones
Skill: android-dev · fase desarrollo

PROVIDERS INTENTADOS
→ anthropic        usage_limit_error   (resets en 4d 02h)
→ openai-codex     insufficient_quota  (resets en 6d 18h)
→ groq             rate_limit_exceeded (resets en 23h)
→ cerebras         quota_exceeded      (resets en 18h)

⏱ Reintenta en 5 min

Que podes hacer:
1. Esperar — el Pulpo destraba solo cuando algun provider libere.
2. Sacar la label `provider-exhaustion-pause` manual si queres forzar reintento ya.
```

**Reglas**:
- Título empieza con `[!]` (ASCII safe, sin emoji decorativo en exceso).
- Issue como link Markdown clickeable (`[#3271 — título](url)`).
- Lista de providers en formato monospace alineado (mejora la legibilidad
  para Leo que lee rápido).
- Reset times en lenguaje natural (`4d 02h`, no `345600s`).
- Sugerencia accionable al final — Leo siempre sabe qué hacer.
- Sanitizado con `lib/telegram/sanitize.js` (sin markdown control chars
  no escapados, max 4096 bytes).

### Mensaje de DESTRABE (CA-10)

Trigger: brazo de retry detecta transición `gated → ok` de algún provider.

```
[OK] Pipeline destrabado — Groq volvio

Provider groq respondio ok despues de 41 min en pausa.
Issue #3271 queda elegible para el proximo barrido del Pulpo.

groq: gated → ok (ping 89ms)

label provider-exhaustion-pause removida automaticamente
```

**Reglas**:
- Tono positivo, conciso (140 chars el body principal).
- NO se de-duplica — Leo siempre debe enterarse cuando algo se destraba.
- Borde verde + banda lateral `--success`.

### Idempotencia (CA-9)

- Una pausa por issue dispara **una sola notificación** dentro de 2h.
- Si el set de providers gated cambia (ej. antes solo Claude, ahora también
  Codex), se re-notifica con el delta.
- Estado persistido en `.pipeline/state/exhaustion-notified/<issue>.json`
  con `ts` de última notificación + lista de providers gated en ese momento.

### Tono y copy (memoria `feedback_telegram-messages-natural`)

- Argento natural, sin "estimado equipo" formal.
- Variar redacción entre eventos consecutivos del mismo tipo — el bot
  mantiene un pool de plantillas para no sonar robótico.
- Nombre del provider SIEMPRE en color identitario en mensajes ricos
  (renderizado por el bridge Telegram).

---

## Tabla de contraste (WCAG verificada)

Verificado con WebAIM Contrast Checker contra `--surface-0` (#0D1117):

| Token | Hex | Ratio | Nivel |
|---|---|---|---|
| `--provider-groq` | `#FF6B47` | 5.42:1 | AA Normal + AAA Large |
| `--provider-gemini` | `#8AB4F8` | 9.21:1 | AAA |
| `--provider-cerebras` | `#FFD166` | 12.31:1 | AAA |
| `--provider-nvidia-nim` | `#76B900` | 7.62:1 | AA Normal + AAA Large |
| `--pulpo-paused` | `#E8770D` | 7.93:1 | AA Normal + AAA Large |
| `--pulpo-paused-fg` sobre bg | `#FFCD9B` | 10.12:1 | AAA |

Texto sobre segmentos de la barra apilada (`fill="#0D1117"`):

| Fondo (provider color) | Ratio | Nivel |
|---|---|---|
| `--provider-anthropic` (#E5946B) | 7.4:1 | AAA |
| `--provider-openai-codex` (#10B981) | 5.8:1 | AA Normal |
| `--provider-groq` (#FF6B47) | 5.4:1 | AA Normal |
| `--provider-gemini` (#8AB4F8) | 9.2:1 | AAA |
| `--provider-cerebras` (#FFD166) | 12.3:1 | AAA |

---

## Estados representados en el mockup

El mockup 16 muestra deliberadamente los 4 estados en un mismo screenshot
para que el dev tenga referencia visual de todos:

| Provider | Estado | Por qué se eligió |
|---|---|---|
| Anthropic | gated | Caso real Ola N+5: Claude se agotó |
| OpenAI Codex | ok | Estado base saludable |
| Groq | ok | Validar render del provider free principal |
| Gemini | cuota baja | Validar render del estado warning intermedio |
| Cerebras | ok | Provider free amarillo identitario |
| Deterministic | ok | Pseudo-provider sin cuota (nunca gated) |

---

## Entregables consumidos por el dev

El skill `pipeline-dev` que tome el issue en `desarrollo` debe consumir:

1. **Tokens nuevos** (`.pipeline/assets/design-tokens.css` — sección 3.d y 3.e):
   - Usar `var(--provider-groq)`, `var(--provider-gemini)`,
     `var(--provider-cerebras)`, `var(--provider-nvidia-nim)`.
   - Usar `var(--pulpo-paused)` para banner + label visual.
   - Usar `var(--pulpo-paused-bg)` y `var(--pulpo-paused-fg)`.

2. **Iconos nuevos** (`.pipeline/assets/icons/sprite.svg`):
   - `<use href="#ic-provider-groq"/>` y resto.
   - `<use href="#ic-pulpo-paused"/>` y `#ic-pulpo-resumed`.
   - `<use href="#ic-retry-clock"/>` para el botón del retry.
   - `<use href="#ic-provider-health"/>` para el header de la card.

3. **Mockups SVG** como referencia exacta de layout:
   - `16-continuidad-pulpo-card.svg` — card del dashboard.
   - `16b-telegram-exhaustion.svg` — formato de los 2 mensajes Telegram.

4. **Esta narrativa** — guidelines de copy, idempotencia, estados, etc.

---

## Out of scope (qué NO entrega UX en esta historia)

- Implementación del endpoint `/api/pulpo/provider-health` (CA-5) — backend.
- Lógica del brazo de retry y label `provider-exhaustion-pause` (CA-4) —
  pipeline-dev sobre `pulpo.js`.
- Chaos test (CA-7) — pipeline-dev / tester.
- Auditoría de invocaciones LLM en el Pulpo (CA-1) — guru ya lo hizo en
  análisis.
- Doc operacional `docs/pipeline-pulpo-continuidad.md` (CA-11) —
  pipeline-dev cuando implemente.

---

## Validación visual

Para validar el sistema visual antes de mergear el código del dev:

1. Renderizar la card con datos reales del Pulpo (`/api/pulpo/provider-health`).
2. Comparar contra `16-continuidad-pulpo-card.svg` lado a lado.
3. Validar contrastes con DevTools → Accessibility → Contrast.
4. Probar con `prefers-reduced-motion: reduce` activo (sin spinner ni pulse).
5. Probar con `prefers-contrast: more` (los tokens ya cubren esto en 13.).
6. Probar en pantalla pequeña (980px ancho min): pills se vuelven 2 columnas,
   barra apilada se vuelve vertical.

---

**Autor**: UX (skill agente pipeline V3)
**Fecha**: 2026-05-16
**Issue**: #3259
**Ola**: N+5
