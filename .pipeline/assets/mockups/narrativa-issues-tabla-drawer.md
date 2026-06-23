# Narrativa UX — EP8-H5: Issues → tabla configurable + panel lateral con timeline · #3958

Mockup: `37-issues-tabla-drawer-v3.svg`. Sin íconos nuevos: reusa el sprite
existente (`assets/icons/sprite.svg`). Sin colores nuevos: todo sale de
`assets/design-tokens.css`. Skill implementador: **pipeline-dev**.

## Qué entrega UX en esta historia

Esta es una historia de **superficie de operador**: densificar la vista de issues
para análisis (tabla configurable) sin perder el contexto (drawer lateral, no
modal). El entregable de UX es el **mockup vinculante + las guidelines** para que
pipeline-dev *ubique* los componentes con el vocabulario visual V3 ya existente,
no que invente diseño. La lógica (riesgo, CSV, filtros) y el riesgo técnico
principal (preservar estado frente al DOM morphing) están en la receta del
arquitecto del body del issue; acá va el **cómo se ve y por qué**.

## 1. Toggle board ↔ tabla (CA-1)

- Segmented control de 2 segmentos, ubicado junto al `it-zoom` en la
  `.matrix-header`. Mismo patrón visual que los toggles existentes del header.
- Segmento activo: fondo `--info-dim` (#1F6FEB) + texto `--text-primary`
  (#E6EDF3, peso 600). Inactivo: fondo `--surface-2`, texto `--text-secondary`.
- Contraste activo verificado: E6EDF3 sobre 1F6FEB → AA.
- El board kanban actual (5 lanes) **no se elimina**: es el otro estado del toggle.

## 2. Columnas configurables (CA-2)

- Botón "Columnas (N)" con `ic-tab-matriz` + chevron (`ic-expand`). Abre un
  popover con checkboxes de las 7 columnas: estado, fase, skill, rebotes, edad,
  ETA p50, riesgo. La columna `#` y `título` son fijas (identidad de la fila).
- El contador `(N)` refleja cuántas columnas están visibles.

## 3. Export CSV (CA-6)

- Botón con `ic-archive-box` teñido `--success` (#3FB950). Acción client-side
  (Blob + `<a download>`). El verde comunica "extracción/descarga segura".
- No abre nada: descarga directa del listado **filtrado** visible.

## 4. Barra de filtros + URL compartible (CA-3)

- Search `q` con `ic-search` (placeholder `--text-disabled`).
- Chips de estado con patrón `aria-pressed`: activo usa el par
  `--success-dim`/`--success` (borde + fondo), inactivo `--surface-0`/`--border`.
- Selectores de fase y skill como dropdowns con chevron.
- A la derecha, un **espejo read-only de la query string** (`?estado=…&fase=…`)
  con `ic-link-out` en `--info`, en fuente mono (`--font-mono`), `--text-dim`.
  Comunica visualmente que la vista es **compartible por URL** y refuerza el
  modelo mental de "este link reconstruye exactamente esto".
- SEC-1/SEC-4 (allowlist + re-validación post-morphing) son requisitos de la
  implementación, no del visual; el mockup sólo asume que `q` ya viene escapado.

## 5. Tabla densa (CA-1/CA-2)

- Header de tabla: fondo `--surface-2`, labels `--text-dim` 12px peso 600 en
  mayúsculas (escala de jerarquía tipográfica del sistema).
- Filas: alto cómodo (~48px) para dos líneas (título + subtítulo). Divisor
  `--border-subtle` entre filas, sin zebra (densidad limpia, dark-first).
- Fila seleccionada: tinte `--info` al 10% + barra lateral `--info` de 3px
  (misma firma que la card seleccionada del board).
- Estado: punto de color (`--success` trabajando, `--info` pendiente) + texto.
- Fase: `ic-fase-*` del sprite + label. Skill: texto plano `--text-secondary`.
- Rebotes: número teñido por severidad (0 → `--text-dim`; ≥2 → `--danger`).
- Edad: `--text-secondary`; si supera p90 se tiñe `--warning` (refuerza la
  regla de riesgo sin depender del badge).

## 6. Riesgo explicable — badge ícono + texto (CA-4 / WCAG AA)

Núcleo visual de la historia. **Nunca color solo**: cada nivel combina forma
(ícono), texto y color. Reusa el set de severidad genérico de H0 (#3953):

| Nivel | Ícono | Token color | Fondo badge |
|-------|-------|-------------|-------------|
| alto  | `ic-bad` (octógono) | `--danger` #F85149 | `--danger-bg` |
| medio | `ic-warn` (triángulo) | `--warning` #D29922 | `--warning-bg` |
| bajo  | `ic-ok` (círculo+check) | `--success` #3FB950 | `--success-bg` |

- El badge es un pill (`--radius-full`) con borde `*-dim` y texto del nivel.
- La **razón textual** (p. ej. "2 rebotes (>=2)", "edad 312m > p90 (210m)")
  va en el `title=` del badge (tooltip) y completa en el drawer. El badge de la
  tabla muestra sólo el nivel; el detalle se lee en el panel lateral.
- Contrastes ya verificados en H0: F85149 5.65:1, D29922 7.50:1, 3FB950 7.45:1
  sobre `--surface-0` → todos AA. No tocar la paleta.

## 7. Panel lateral / drawer — NO modal (CA-5)

- `<aside class="it-drawer">` a la derecha, **lado a lado** con la tabla: la
  lista queda visible y usable detrás (no overlay opaco bloqueante).
- Fondo `--surface-2`, rail de firma gradient cyan→blue a la izquierda del
  drawer (coherente con el rail del panel).
- Contenido por issue: header (#, título, link-out, botón cerrar `ic-collapse`),
  chips de estado/fase/skill, **caja de riesgo explicable** con todas las
  razones, y el **timeline de fases**.
- SEC-2: todo texto interpolado (título de issue, skill, motivo de rebote,
  labels) pasa por `escapeHtml` compartido. No es decisión de diseño, es
  requisito; el mockup lo asume.

## 8. Timeline de fases proporcional al tiempo (CA-5)

- Barra horizontal segmentada donde **el ancho de cada segmento es proporcional
  a `durationMs`** de esa fase. La fase en curso (dev) ocupa lo acumulado hasta
  `updatedAt`. Las fases no iniciadas se muestran en `--surface-3` apagado con
  `ic-stage-not-entered`.
- Color de segmento por familia de fase: definición (`analisis`/`criterios`) en
  la familia `--purple`/`--purple-dim`; ejecución (`dev`) en `--info-dim`.
- SEC-2 (timeline): los anchos se derivan de valores **numéricos saneados**
  (`width:${Number(pct)}%`), nunca de strings de duración crudos en `style=`.
- Debajo, filas de detalle por fase (ícono + nombre + duración + skill) y la
  lista de rebotes con `ic-estado-rebote` y su motivo.

## Guidelines para pipeline-dev (ubica assets, no inventa diseño)

- **Cero HEX nuevo, cero ícono nuevo**: consumir `var(--token)` de
  `design-tokens.css` y `<use href="#ic-…">` del sprite. Todos los IDs usados en
  el mockup ya existen (verificado).
- **Severidad siempre ícono + texto** (`renderStatusBadge` / set H0). No
  construir el `href` del ícono desde input externo (allowlist server-side).
- **El estado de UI nuevo** (vista tabla, columnas elegidas, drawer abierto +
  issue, scroll de tabla) debe sumarse a `__it_state` (save+restore) para
  sobrevivir el `softRefresh` de 10s — es el punto que más rebotes puede
  generar; el mockup lo nota explícitamente en el footer del drawer.
- **Drawer lado a lado, no overlay**: respetar el layout de dos columnas; la
  tabla no se oscurece ni se bloquea cuando el drawer está abierto.
- **Densidad sin perder accesibilidad**: tamaño mínimo de texto 12px en la
  tabla (escala `--fs-xs`); los pills de riesgo a 12px con peso 600.
