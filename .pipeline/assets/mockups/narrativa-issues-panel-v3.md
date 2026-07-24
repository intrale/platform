# Narrativa UX — Ventana Issues V3 (#3730, split de #3715)

> Spec de diseño **vinculante** para la extracción de la ventana Issues del
> monolito `.pipeline/dashboard.js` / `views/dashboard/satellites.js` →
> `.pipeline/views/dashboard/issues.js`.
> Acompaña al mockup `28-issues-panel-v3.svg`. Todos los colores provienen de
> `.pipeline/assets/design-tokens.css` — **CERO** HEX nuevo. Todos los íconos
> vía `<use href="#ic-…">` del sprite global `.pipeline/assets/icons/sprite.svg`.

---

## 1. Qué es la ventana Issues (Interpretación B — vista operacional)

UX cerró por **Interpretación B**
(https://github.com/intrale/platform/issues/3730#issuecomment-4584963619),
aceptada por `architect` + `po`. El módulo nuevo es la **vista operacional del
backlog** servida en la ruta canónica `/issues` (reemplaza a
`satellites.renderIssues`, NO a la tabla telemétrica cliente de `/consumo`).

Cinco razones empíricas de la decisión:

1. La vista operacional responde la pregunta del operador *"¿qué se está
   procesando y qué está trabado ahora?"* — no *"¿cuánto costó cada issue?"*.
   Esa segunda pregunta es telemetría y vive en `/consumo` hasta que #3735
   (Costos) la absorba (blindado por CA-PO2).
2. El operador necesita **accionar** sobre cada issue (re-priorizar, pausar,
   abrir en GitHub), no sólo mirar números. Las cards exponen acciones; la
   tabla telemétrica es de sólo lectura.
3. El backlog cambia de orden y estado todo el tiempo → una **grilla de cards
   con polling + morphing por ID** comunica el estado vivo mejor que una tabla
   densa de filas.
4. La tabla telemétrica de `/consumo` (`dashboard.js:8116-8483`) tiene un
   `lastSnapshot` cliente propio; mezclar ambas vistas en un módulo arriesga
   colisión de estado (R-2). Separarlas es más limpio.
5. El patrón de ventana operacional con cards + filter bar + drilldown ya está
   validado en Equipo V3 (#3727) y Home V3 — reusar convención, no inventar
   paradigma nuevo.

**Implicancia para el dev**: el módulo nuevo es greenfield siguiendo `home.js`.
NO tocar `dashboard.js:8116-8483` (R-1). El swap se hace en
`dashboard-routes.js:207` con indirección por arrow (R-4).

---

## 2. Identidad visual

- **Rail vertical 3px** a la izquierda del panel, gradient
  `brand-cyan (#00D6FF) → brand-blue (#1890FF)` (`#railIssues`), como firma del
  panel — coherente con la familia V3 (Equipo usa cyan→purple→success; Issues
  usa el gradient brand puro porque es la ventana "núcleo" del pipeline).
- **Fondo** `--surface-0 (#0D1117)`; cards en `--surface-1 (#161B22)` con
  borde `--border (#30363D)` y elevación sutil (`#elev`, dropshadow dy=2).
- **Chips de estado operacional** por color semántico del token-set:
  - `trabajando` → `--info (#58A6FF)` sobre `--info-bg`
  - `listo` → `--success (#3FB950)` sobre `--success-bg`
  - `pendiente` → `--text-dim (#8B949E)` sobre `--surface-2`
  - `bloqueado` (`blocked:dependencies`) → `--warning (#D29922)` sobre `--warning-bg`
  - `rebote` → `--danger (#F85149)` sobre `--danger-bg`
  - `needs-human` → `--purple (#BC8CFF)` sobre `--purple-bg`
- **Tipografía** sistema (`-apple-system, Segoe UI, Roboto`). `font-variant-numeric:
  tabular-nums` en prioridad, bounces y #issue para que los números no bailen.

---

## 3. Anatomía y jerarquía (orden de lectura top-down)

Entry point único: `renderIssuesHTML(opts)`.

### 3.1 `iss-head` — cabecera
- Ícono `<use href="#ic-issues-count">` + título **Issues** (gradient `#brandText`).
- Chevron colapsable `<use href="#ic-collapse">` + popout `<use href="#ic-link-out">`.
- Summary a la derecha: contador total + desglose corto
  (`N trabajando · M listos · K bloqueados`). El contador es `aria-live="polite"`.

### 3.2 `issues-filter-bar` — barra de filtros (`role="toolbar"`)
- Fila de **chips de estado** (`data-filter`): Todos · Trabajando · Listos ·
  Bloqueados · Rebotes. Cada chip es un `<button>` con `aria-pressed`,
  `aria-label` descriptivo y `data-filter`. El chip activo se distingue por
  fondo + borde + `aria-pressed="true"` (NUNCA sólo por color → también peso de
  fuente y borde).
- **Search input** `#issues-search` (`type="search"`, `aria-label="Filtrar
  issues por número, fase o título"`), full-width debajo de los chips.
- **Filtro por fase** opcional `#issues-filter-phase` (`<select>` accesible).

### 3.3 `issues-grid` — grilla de cards (`aria-live="polite"`)
- `display:grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr))`,
  gap 14px. Responsive sin media queries manuales.
- Cada card = `renderIssueCard(issue)`. Anatomía de la card:
  - **Top row**: badge de prioridad (`#3` o `—`) + `#<number>` (link a GitHub) +
    chip de estado operacional a la derecha.
  - **Título**: 2 líneas máx con ellipsis; prefijo `⏸` si está pausado.
  - **Meta row**: ícono+label de fase actual (`<use href="#ic-fase-<fase>">`),
    badge de bounces (`N×`, amber si >2), chip rebote `↩ rechazo` si aplica
    (con tooltip del motivo, escapado).
  - **Action row**: botones operativos (ver §3.5), todos con `title=""` nativo
    escapado y `data-issue` + `data-action` (delegación, NO `onclick` inline).
- Card completa: `tabindex="0"`, `role="article"`,
  `aria-label="Issue <num>: <title>, fase <fase>, estado <estado>"`.
- Click / Enter en la card (fuera de los botones) → abre drilldown (§3.4).

### 3.4 `issues-dialog` — drilldown (`<dialog>` nativo)
- `<dialog id="issues-dialog">` abierto con `dialog.showModal()` → **focus trap
  nativo del browser** (CA-UX-7). Cierre con `Esc` (nativo) + botón ✕ +
  click en backdrop.
- Contenido: header con `#<num>` + título + chip estado; **timeline de fases**
  (sizing → análisis → criterios → dev → build → verificación → aprobación →
  entrega) con ícono `<use href="#ic-fase-*">` y estado por fase
  (`#ic-cell-pass`/`#ic-cell-fail`/`#ic-cell-skipped`); bloque **motivo de
  rechazo** si `rebote` (texto escapado, fondo `--danger-bg`); fila de acciones
  (abrir en GitHub, pausar/reanudar, máxima prioridad).
- `aria-labelledby="issues-dialog-title"`.

### 3.5 Acciones operativas (cada una con tooltip `title=""`)
| Acción | Ícono | `data-action` | Tooltip |
|---|---|---|---|
| Máxima prioridad | `#ic-promote` (▲▲) | `move-top` | "Mover a máxima prioridad" |
| Subir | ▲ | `move-up` | "Subir un puesto" |
| Bajar | ▼ | `move-down` | "Bajar un puesto" |
| Mínima prioridad | ▼▼ | `move-bottom` | "Mover a mínima prioridad" |
| Pausar / Reanudar | `#ic-pause-lock` / `#ic-play` | `pause`/`resume` | "Pausar issue" / "Reanudar issue" |
| Abrir en GitHub | `#ic-link-out` | (link `<a>`) | "Abrir en GitHub" |

---

## 4. Tabla de contrastes WCAG AA

Todos los ratios de texto ≥ 4.5:1 sobre su superficie. Estados nunca **sólo**
por color (siempre ícono + texto + peso/borde).

| Elemento | Color texto | Fondo | Ratio | OK |
|---|---|---|---|---|
| Título de card | `--text-primary #E6EDF3` | `--surface-1 #161B22` | 13.9:1 | ✅ |
| `#issue` link | `--info #58A6FF` | `--surface-1` | 6.1:1 | ✅ |
| Meta / fase label | `--text-secondary #B1BAC4` | `--surface-1` | 9.1:1 | ✅ |
| Prioridad / timestamp | `--text-dim #8B949E` | `--surface-1` | 5.0:1 | ✅ |
| Chip trabajando | `--info #58A6FF` | `--info-bg` | ≥ 4.6:1 | ✅ |
| Chip listo | `--success #3FB950` | `--success-bg` | ≥ 4.5:1 | ✅ |
| Chip bloqueado | `--warning #D29922` | `--warning-bg` | ≥ 4.5:1 | ✅ |
| Chip rebote | `--danger #F85149` | `--danger-bg` | ≥ 4.7:1 | ✅ |
| Focus ring | `--border-strong #484F58` outline 2px | — | visible | ✅ |

---

## 5. Seguridad — reglas inquebrantables (CA-D1 + recomendación `security`)

- `escapeHtmlSsr()` en TODO cuerpo de texto; `escapeHtmlAttr()` en
  `title=`/`aria-label=`/`data-*=`. Cuando #3722 cierre: `require('../../lib/escape-html')`,
  fallback a helpers locales con la misma semántica (escapa `& < > " ' /`).
- `renderIssueCard` valida `Number.isFinite(num) && num > 0` ANTES de interpolar
  `issue.number`; retorna `''` si falla (cierra R-6). Cubierto por test 4.
- **Cero `innerHTML` con datos del usuario**: morphing por ID + `textContent`.
  Composición HTML sólo con strings ya escapados.
- **Cero `onclick="fn(' + valor + ')"`**: delegación de eventos con
  `data-issue` + `data-action` (alineado con futuro CSP, #3758).
- Tooltips con `title=""` HTML nativo, valor por `escapeHtmlAttr`. NO tooltip
  custom con `innerHTML`.
- Test SSR inyecta payloads canónicos (`<img src=x onerror=alert(1)>`,
  `"><svg onload=alert(1)>`) en `title` + `labels` y asserta que el output NO
  contiene `onerror=`/`onload=`/`<img`/`<svg` crudos (CA-D1, tests 2-3).

---

## 6. Microcopy (tono y reglas de texto)

- Español rioplatense neutro, conciso, accionable.
- Contador summary: `"12 issues · 3 trabajando · 2 listos · 1 bloqueado"`.
- Empty state: `<span class="empty-label">Sin issues que coincidan con el
  filtro</span>` (NO desaparecer la grilla en blanco).
- Estado vacío total del backlog: `"El pipeline está al día — sin issues
  activos"`.
- Tooltips de acción imperativos breves (ver §3.5). El motivo de rechazo en el
  chip rebote se trunca a 300 chars + `…`.

---

## 7. Mapa a criterios de aceptación (CA-UX-1..7)

- **CA-UX-1** — `views/dashboard/issues.js` exporta `renderIssuesHTML` +
  `renderIssueCard` + `renderIssuesClientScript` + `escapeHtmlSsr` +
  `escapeHtmlAttr` (funciones puras testeables). Cubre §3.
- **CA-UX-2** — SOLO tokens de `design-tokens.css`; cero HEX literal en el
  módulo. Verificable con test 7 (regex de `color:`/`background:` con `#hex`).
- **CA-UX-3** — Iconos exclusivamente vía `<use href="#ic-…">` del sprite;
  cero SVG `<path>` inline. Verificable con test 8.
- **CA-UX-4** — Cards con `tabindex="0"`, `role="article"`, `aria-label`
  descriptivo. Verificable con test 5.
- **CA-UX-5** — Chips de filtro con `aria-pressed`, `aria-label`, `data-filter`.
  Verificable con test 6.
- **CA-UX-6** — Tooltips con `title=""` HTML nativo escapado con
  `escapeHtmlAttr()`. Cubre §3.5.
- **CA-UX-7** — Drilldown `<dialog>` nativo con focus trap (`showModal()`) +
  cierre con `Esc`. Cubre §3.4 + R-5.

Estos 7 CA cubren el espectro: estructura del módulo (1), identidad visual
(2-3), accesibilidad WCAG AA (4-5-6-7).

---

## 8. Notas de implementación para el dev (no perder en la extracción)

- Seguir plantilla de `home.js` (`'use strict'` + `loadTheme()` +
  `escapeHtmlSsr()` + helpers locales + `module.exports`).
- SSR + DOM morphing por ID (`#issues-grid`, `#issues-filter-state`,
  `#issues-filter-phase`, `#issues-search`, `#issues-dialog`). NO Virtual DOM.
- Nombres de estado cliente distintos al de `/consumo`: usar `issuesSnapshot`,
  `selectedIssueId` (evita colisión R-2; grep manual trivial).
- Datos: reusar el endpoint que ya alimenta `satellites.renderIssues`
  (`matrix` + `priorityOrder` + `labels` + `faseActual` + `estadoActual` +
  `bounces` + `rebote`/`motivo_rechazo`/`rechazado_en_fase`). NO inventar API.
- Swap en `dashboard-routes.js:207` por arrow (R-4); conservar `sat.renderIssues`
  como fallback en el MISMO commit; eliminar `satellites.renderIssues` (820-919)
  al final del PR.
- PR body: screenshot real `/issues` lado a lado con `28-issues-panel-v3.svg`
  (CA-F2).
- `docs/pipeline/dashboard-v3-inventory.md`: entrada de la ventana Issues +
  link al comment B de UX.

---

> Convención de concurrencia: UX deja este `.md` + el SVG en
> `.pipeline/assets/mockups/` **sin commitear**. El dev los copia a su worktree
> de la rama `agent/3730-*` y los versiona en su PR (declarado en el pre-checklist
> de la receta de `architect`).
