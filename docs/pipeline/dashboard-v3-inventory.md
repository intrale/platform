# Dashboard V3 — Inventario por ventana (semilla)

> **Origen:** semilla creada por `/ux` durante #3732 (split de #3715 — ventana Ops).
> **Audiencia:** devs de pipeline que implementen los splits #3725..#3736.
> **Convencion:** una tabla por ventana, con la trazabilidad `pieza visible → fuente de datos → destino post-rediseño V3`.
> Cada split sucesivo del epico extiende este doc agregando su seccion.

## Por que existe

El monolito `.pipeline/dashboard.js` tiene 10.691 lineas y todas las ventanas conviven con el `pageShell` de `views/dashboard/satellites.js`. El epico #3715 lo descompone en `.pipeline/views/dashboard/*.js` por ventana. Para que el rediseño V3 no pierda piezas (CA-A1, CA-A2 heredados), cada split documenta aca lo que migra, lo que se rediseña y lo que se elimina.

El doc tambien sirve para los reviewers (PO, security) y para que UX/QA puedan auditar consistencia visual entre ventanas sin abrir el codigo.

## Convencion de la tabla

| Campo | Significado |
|---|---|
| **Pieza** | Componente visible de la ventana (banner, grid, chip, panel). Nombre humano. |
| **Estado actual** | Donde vive hoy (archivo + lineas + ID DOM si aplica). |
| **Fuente de datos** | Endpoint o slice de `lib/dashboard-slices.js` que la alimenta. |
| **Destino V3** | Decisiones del rediseño: mover/quitar/agregar/preservar. Marca diferencia con el estado actual. |
| **Token / icono** | Token de `assets/design-tokens.css` o simbolo de `assets/icons/sprite.svg` que usa la pieza rediseñada. |
| **Tooltip CA-C5** | Texto del tooltip informativo (cuando aplica) — atributo `title=` + `aria-label=`. |

## Ventana **Ops** — split #3732

**Modulo destino:** `.pipeline/views/dashboard/ops.js`
**Slug del router:** `?view=ops` (preserva el path legacy `/ops`).
**Mockup adjunto:** `.pipeline/assets/mockups/28-ops-v3.svg` (1080×1920, kiosk vertical).
**Out of scope (CA-B2):** acciones operativas mutantes (kill, restart, retry). Split aparte con CSRF + audit log.

### Piezas que se preservan (CA-B1)

| Pieza | Estado actual | Fuente de datos | Destino V3 | Token / icono | Tooltip CA-C5 |
|---|---|---|---|---|---|
| Banner Telegram caido | `satellites.js:1003-1167` → `<div id="ops-tg-banner">` | `state.telegramHealth.lastError` (slice `opsSlice` linea 859) | **Preserva + rediseña**: dual-encoding rail rojo + icono bot-roto + texto. Oculto si `tgHealth.ok===true`. | `--danger`, `--danger-bg`, `--danger-dim`, rail `linearGradient dangerStripe` | `"Origen del error reportado por Telegram API"` |
| Grid de procesos | `satellites.js:1005-1008` → `<div id="ops-procesos" class="ops-grid">` | `state.procesos` (alive, pid, uptime por proceso) | **Preserva**: 5 cards en grid `auto-fill minmax(220px, 1fr)`. Cards de `listener` y `svc-telegram` heredan estado `bot-down` cuando TG cae. | `--success` (vivo), `--danger` (caido), `--surface-1`, `--surface-2` | (por chip de cola, ver abajo) |
| Chips de cola por proceso | `satellites.js:1056-1085` (`PROC_QUEUES`) → `.ops-queue-group` | `state.servicios[queue]` con `{ pendiente, trabajando, listo }` | **Preserva**: chip pendiente en `--warning` si v>0, trabajando en `--info` si v>0, listo siempre en `--text-dim`. | `--warning` (pend), `--info` (work), `--text-dim` (done). Iconos: `ic-fase-criterios`/`ic-fase-dev`/`ic-fase-aprobacion` (semantica reusada) o emojis ⏳⚙✓ preservados. | `"N archivos pendientes (sin tomar)"` / `"N archivos en proceso"` / `"N archivos completados"` |
| Reconciler stale orders 24h | `satellites.js:1010-1018` → `#stale-orders-count` + `#stale-orders-breakdown` | `/api/dash/reconciler-stale-orders` con `{ total_24h, by_reason }` | **Preserva**: numero grande en `--warning` si total>0, en `--text-dim` si total===0 (saludable). Breakdown lista por motivo con linea separadora. | `--warning`, `--text-dim`, `--surface-1`, font-family `var(--font-mono)` | `"Ordenes que el reconciler descarto en las ultimas 24 horas"` |

### Piezas que se rediseñan (CA-C2)

| Pieza | Estado actual | Fuente de datos | Destino V3 | Token / icono | Tooltip CA-C5 |
|---|---|---|---|---|---|
| QA Environment | `satellites.js:1020-1022` → `<pre id="ops-qaenv" class="ops-pre">` (dump JSON crudo, anti-patron UX) | `state.qaEnv`, `state.qaRemote`, `state.infraHealth`, `state.telegramHealth` (slice `opsSlice`) | **Rediseña**: 4 mini-cards (`qaEnv · local`, `qaRemote · AWS Lambda`, `infraHealth`, `telegramHealth`). Cada card con badge de salud + meta key:value en mono + ultimo error truncado a 80 chars. **NO `<pre>` JSON crudo.** | Badge: `--success` (OK), `--warning` (DEGRADADO), `--danger` (CAIDO). Mono: `var(--font-mono)`. Rail: stripe del color de la salud. | `"Algun componente del entorno reporto estado WARN"` (badge degradado) / `"Entorno saludable, ultimo ping OK"` (badge ok) |

### Piezas que NO entran (out-of-scope)

| Pieza | Motivo |
|---|---|
| Boton "Reiniciar proceso" | Accion mutante → split aparte con CSRF + audit log (REQ-SEC-4). |
| Boton "Retry stale orders" | Idem. |
| Boton "Rotar token Telegram" | Idem. La accion sugerida queda como texto en el banner ("rotar token con BotFather y guardarlo en ~/.claude/secrets/telegram-config.json"). |
| Suite de regresion visual automatizada | Cubierto por #3387, fuera de scope del split. |
| Migracion a `lib/escape-html.js` compartido | Dependencia del split #1 del epico; cuando aterrice, PR de unificacion toca `ops.js` + `home.js` + `multi-provider*.js`. |

### Fallback inerte (CA-A3 / REQ-SEC-7)

Cuando `require('./views/dashboard/ops')` arroja (sintaxis rota, dependencia faltante, etc.), `dashboard.js` debe renderizar un panel visible con:

- Icono warning (`stroke="#D29922"`).
- Titulo "Ventana Ops no disponible".
- Subtitulo "El modulo views/dashboard/ops.js fallo al cargar. Ver logs del dashboard para detalle."
- Linea mono "log("ops view unavailable", e) emitido por dashboard.js — el render no queda en blanco."

Variante ilustrada en el mockup adjunto, seccion "VARIANTE FALLBACK INERTE".

### Variante healthy (sin estado degradado)

Cuando `tgHealth.ok===true && stale.total_24h===0 && all procesos.alive===true`, la ventana muestra el grid de procesos verde + chip "Pipeline saludable" en footer. El banner Telegram se oculta (`.ops-banner-hidden { display: none; }` ya en CSS del satellites). Variante ilustrada en el mockup.

### Tests requeridos (CA-D2, CA-G1)

`.pipeline/views/dashboard/__tests__/ops.test.js` con `node:test` + `http.createServer` efimero. Cobertura minima:

1. Render SSR con estado valido (todos los procesos vivos, sin descartes).
2. Render con estado degradado (TG down, svc-emulador caido, stale > 0).
3. Payload XSS canonico en: contenido textual, atributo `title=`, atributo `aria-label`. Espejo del set de `home.test.js`.
4. Fallback inerte cuando se simula error en una sub-pieza (CA-A3).

### Smoke curl (CA-G2)

```bash
# Path legacy
curl -s http://127.0.0.1:3200/ops | grep -c 'ops-procesos\|stale-orders-count\|ops-qaenv\|ops-tg-banner'
# Debe devolver 4

# Query
curl -s 'http://127.0.0.1:3200/?view=ops' | grep -c 'ops-procesos\|stale-orders-count\|ops-qaenv\|ops-tg-banner'
# Debe devolver 4
```

## Ventana **Bloqueados** — split #3729

> Sub-historia hermana en curso. Documentada en `assets/mockups/27-bloqueados-v3.svg` con 10 decisiones congeladas. Esta entrada se completa cuando el split aterrice en main.

## Otras ventanas del epico #3715

| Split | Ventana | Mockup | Estado |
|---|---|---|---|
| #3725 | Frame + brand bar | — | pendiente |
| #3726 | Home (KPIs principales) | `assets/mockups/26-dashboard-main-v3.svg` | en flight |
| #3727 | Equipo | — | pendiente |
| #3728 | Pipeline (flujo de agentes) | — | en flight |
| #3729 | Bloqueados | `assets/mockups/27-bloqueados-v3.svg` | en flight |
| #3730 | Issues | — | pendiente |
| #3731 | Consumo | — | pendiente |
| #3732 | **Ops (este split)** | `assets/mockups/28-ops-v3.svg` | criterios |
| #3733 | Multi-provider | — | pendiente |
| #3734 | Multi-provider coverage | — | pendiente |
| #3735 | Allowlist audit trail | — | pendiente |
| #3736 | Modo descanso | — | pendiente |

> A medida que cada split entra a `criterios`, su `/ux` debe agregar la fila correspondiente con la tabla `pieza → fuente → destino`.

## Convenciones inquebrantables del rediseño V3

1. **Sin HEX libres en el codigo** — toda regla de estilo viene de `assets/design-tokens.css`. Si falta un token, se agrega ahi.
2. **Sin iconografia inline** — todo `<svg>` viene del sprite `assets/icons/sprite.svg` via `<use href="#ic-*">`.
3. **Sin `<pre>` con JSON crudo** — anti-patron UX. Reemplazar por estructuras semanticas (mini-cards, badges, listas key:value).
4. **Dual-encoding de severidad** — nunca solo color: agregar icono + texto + forma para WCAG AA (CA-E1).
5. **Tooltips informativos (CA-C5)** — toda zona accionable o informativa con `title=` + `aria-label=`. La parte dinamica del tooltip pasa por `escapeHtmlSsr` (REQ-SEC-3).
6. **Escape SSR canonico** — toda interpolacion de string dinamico pasa por `escapeHtmlSsr` (CA-D1). Mientras `lib/escape-html.js` no aterrice (split #1), seguir el patron inline de `home.js:33-41`.
7. **Sanitizado de payload runtime** — el estado consumido por la vista pasa por `lib/sanitize-payload.js` antes de entrar al SSR (CA-D3 / REQ-SEC-6).
8. **Fallback inerte (CA-A3)** — si `require` del modulo de vista falla, mostrar mensaje visible al operador. Nunca string vacio silencioso.

## Idioma

Doc operativa en español. Identificadores de codigo, slugs del router, labels GitHub y env vars en ingles.
