# Narrativa UX — EP8-H0: Sistema de diseño (fundamentos) · #3953

Mockup: `29-design-system-h0.svg`. Asset de íconos: 4 nuevos symbols en `assets/icons/sprite.svg`.

## Qué entrega UX en esta historia

H0 es la base del rediseño del dashboard V3. No es una pantalla, es el **vocabulario visual**
que las historias H1–H12 (#3954–#3965) van a consumir. Por eso el entregable de UX acá no es
"una pantalla linda" sino un **set de assets estable y verificable**:

### 1. Set de íconos de severidad genérico (gap real cerrado)

La receta del arquitecto y CA-4 referencian `ic-ok / ic-warn / ic-bad / ic-info` como allowlist
de `renderStatusBadge`. **No existían en el sprite** — solo había variantes de dominio
(`ic-health-ok`, `ic-conn-err`, `ic-cell-*`). UX produce el set genérico, decoplado del dominio,
en el mismo estilo de línea monocromática (`currentColor`, stroke 1.75, viewBox 24×24) que el
resto del sprite:

| ID | Glifo | Semántica |
|----|-------|-----------|
| `ic-ok` | círculo + check | correcto / éxito / saludable |
| `ic-warn` | triángulo + exclamación | precaución / atención |
| `ic-bad` | octógono (stop) + exclamación | error / crítico / bloqueante |
| `ic-info` | círculo + "i" | informativo / neutral |

El octógono de `ic-bad` lo diferencia a propósito del círculo-X de `ic-conn-err`, para que la
severidad se lea por **forma** además de color.

### 2. Severidad nunca solo por color (CA-4 / WCAG AA)

Cada `status-badge` combina **ícono + texto legible**. El color refuerza, no comunica solo.
Contraste de los tokens sobre `--in-bg #0d1117` (verificado empíricamente, fórmula WCAG 2.1):

- `--in-ok` #3fb950 → **7.45:1** ✅
- `--in-warn` #d29922 → **7.50:1** ✅
- `--in-bad` #f85149 → **5.65:1** ✅
- `--in-info` #58a6ff → **7.49:1** ✅

Todos superan el umbral AA de texto normal (4.5:1). No hay que tocar la paleta.

### 3. Componentes y patrones mostrados en el mockup

- **kpi-card** (ok/warn/bad) con barra lateral de color + ícono de severidad, preservando los
  `id` invariantes del DOM morphing (`kpi-prs`, `kpi-cycle`, `kpi-bounce`, …).
- **agent-pill** con punto de estado + skill + issue.
- **indicador "actualizado hace Xs"** (frescura del dato).
- **banner stale** (CA-2): mensaje genérico "datos desactualizados — reintentando", el detalle
  del error va solo a consola (R3), nunca al DOM.
- **modal de confirmación con preview** (CA-3): muestra skill/issue/worktree afectado antes de
  ejecutar; datos escapados por default; CSRF automático en el POST.
- **empty-state celebratorio**: tono positivo cuando no hay trabajo bloqueado.

## Guidelines para el dev (android/web-dev no inventa diseño, ubica assets)

- Usar **siempre** `<use href="#ic-ok|warn|bad|info">` vía la allowlist server-side; nunca
  construir el `href` desde input externo (R4 / SVG injection).
- El texto del badge se escapa con `escapeHtmlText` igual que cualquier dato dinámico.
- No agregar colores nuevos: la escala de severidad ya está en `theme.css` y pasa AA.
- Mover los estilos compartidos de `.kpi-card`/`.agent-pill`/`.status-badge` a `theme.css`
  (hoy inline en `home.js`), sin renombrar clases ni IDs.
