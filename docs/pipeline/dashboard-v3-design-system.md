# Dashboard V3 — Sistema de diseño compartido (EP8-H0 · #3953)

Fundamentos del rediseño del dashboard V3. Estos módulos son **prerequisito de
H1–H12 (#3954–#3965)**; sus firmas exportadas son **API estable** — no romper sin
coordinar con la épica #3952.

Todos viven en `.pipeline/views/dashboard/`. Patrón: módulo Node con funciones
puras (SSR) o strings de código cliente embebible (igual que `nav-tabs.js`).

---

## `components.js` — componentes SSR (server-side)

```js
const { renderKpiCard, renderStatusBadge, renderAgentPill } = require('./components');
```

### `renderStatusBadge({ severity, label, id?, title? }) -> string`
Badge de severidad con **ícono + texto** (CA-4, WCAG AA). `severity ∈ ok|warn|bad|info`
(cualquier otro valor cae a `info`). El ícono sale de una allowlist server-side
(`SEVERITY_ICON`); el `href` del `<use>` **nunca** se construye con input externo
(R4). `label` se escapa internamente.

### `renderKpiCard({ id, valueId?, icon?, label, value?, sub?, severity?, title?, extraClass? }) -> string`
Tarjeta KPI. Misma estructura/clases que la copia inline de `home.js` para no
romper el **DOM morphing** (el cliente hace `setText` sobre `valueId` y toggle de
`kpi-ok|warn|bad` sobre `id`). `value` por defecto `'…'`. `severity` ok/warn/bad
agrega clase; `info` se ignora (estado neutro). Todo dato dinámico se escapa.

### `renderAgentPill({ skill, issue?, fase?, severity?, label?, title? }) -> string`
Pill de agente: skill (texto + clase `agent-pill-skill-<norm>` saneada) + `#issue`
(solo si entero > 0) + badge de severidad opcional. Todo escapado.

Otros exports: `SEVERITY_ICON`, `SEVERITIES`, `normalizeSeverity`, `renderSeverityIcon`.

---

## `fetch-client.js` — wrapper de fetch (cliente) + banner SSR

```js
const { FETCH_CLIENT_JS, renderStaleBanner, STALE_MESSAGE } = require('./fetch-client');
```

- **`FETCH_CLIENT_JS`** (string): inyectar una vez en el `<script>` de la página
  (antes de los helpers de la vista). Define los globals `fetchJson(url, opts)`,
  `showStaleBanner()`, `clearStaleBanner()`, `nhCsrfHeaders()`.
  - `fetchJson` devuelve el JSON o `null` en fallo (no rompe el render). En fallo
    muestra el banner genérico "Datos desactualizados — reintentando…" y loguea el
    detalle **solo a consola** (R3, sin fuga al DOM). En métodos no-GET adjunta
    `X-CSRF-Token` desde `<meta name="csrf-token">` (R2).
- **`renderStaleBanner()`** (SSR): markup del banner, oculto por default. Opcional
  (el cliente lo crea en caliente si no está).

---

## `confirm-modal.js` — confirmación con preview (cliente)

```js
const { CONFIRM_MODAL_JS } = require('./confirm-modal');
```

- **`CONFIRM_MODAL_JS`** (string): inyectar en el `<script>` después de
  `FETCH_CLIENT_JS`. Define:
  - `inConfirm({ title, message?, preview?, confirmLabel?, cancelLabel?, danger? }) -> Promise<boolean>`
    Modal accesible (role=dialog, focus trap, ESC=cancelar, Enter=confirmar). **XSS-safe
    por default**: todo dato dinámico se inserta con `textContent`, nunca `innerHTML`
    (R1). `preview` es `[{ label, value }]`.
  - `inConfirmPost({ ...inConfirm, url, method?, body? }) -> Promise<json|null>`
    Confirma y, si acepta, hace el POST destructivo con CSRF automático (vía
    `fetchJson`). Reemplaza el `confirm()` nativo en acciones destructivas (CA-3).

---

## Estilos

`theme.css` es la fuente canónica de `.status-badge`, `.kpi-card`, `.agent-pill`,
`.in-stale-banner`, `.in-modal-*`, `.in-freshness`. La consumen los satélites (que
cargan `theme.css`). `home.js` conserva su copia inline porque no carga `theme.css`.

Severidad siempre dual-encoded (ícono + texto). Contraste WCAG AA verificado por UX
sobre `--in-bg`: ok 7.45:1 · warn 7.50:1 · bad 5.65:1 · info 7.49:1. No se introducen
colores nuevos: toda severidad sale de los tokens `--in-*`.

---

## Vistas que ya consumen estos fundamentos (#3953)

| Vista | Componentes (CA-1) | fetch wrapper (CA-2) | modal (CA-3) |
|-------|--------------------|----------------------|--------------|
| `home.js` | `renderKpiCard` (4 KPIs) | follow-up | follow-up |
| `providers.js` | `renderStatusBadge` | — (SSR puro) | — |
| `kpis.js` | `renderStatusBadge` (salud) | — | — |
| `bloqueados.js` | — | ✅ | ✅ |
| `descanso.js` | — | ✅ | ✅ |
| `satellites.js` | — | ✅ | ✅ |
| `matriz.js` | — | ✅ | — (sin confirm) |

> `home.js` (kiosk, ~3700 líneas, CSS inline divergente de `theme.css`) migra su
> `fetchJson`/`confirm()` como follow-up dentro de la épica para no arriesgar la
> vista principal en H0 (autorizado por PO en los criterios de #3953). Su KPI grid
> ya usa `renderKpiCard`.
