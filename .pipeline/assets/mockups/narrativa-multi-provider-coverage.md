# Narrativa visual — Widget "Multi-Provider Smoke Test Coverage" (#3669)

> Referencia descriptiva para `pipeline-dev` al implementar el widget en
> `.pipeline/dashboard.js`. Esta narrativa NO es instrucción autoritativa:
> el dev debe verificar contra el mockup `23-multi-provider-coverage-widget.svg`
> y los design tokens `design-tokens.css` (familia 3.c y 3.d para providers,
> familia 3 para semánticos).

## Posición en el dashboard

- **Tab**: `Multi-Provider` (mismo tab que las cards del mockup 17).
- **Posición vertical**: DEBAJO de las cards de salud de free providers
  (mockup 17). El widget agrega una sección separada con su propio header
  y banner — no reemplaza ni se mezcla con las cards existentes.
- **Anchor URL**: `/multi-provider/coverage` (también accesible como ancla
  `#smoke-test-coverage` dentro del tab).

## Anatomía del widget (top → bottom)

### 1. Header de sección (1440 × ~80px)

- Breadcrumb: `Multi-Provider · Smoke Test Coverage (#3669)` en
  `--text-dim` 13px.
- Título H2: "Cobertura del fallback chain — matriz skill × provider" en
  `--text-primary` 28px peso 600.
- Subtítulo descriptivo en `--text-secondary` 14px aclarando que la data
  proviene del snapshot persistido y que el widget NO dispara invocaciones
  al abrir.

### 2. Banner del último run (1392 × 58px)

- Fondo `--teal-bg` con borde `--teal` (familia "validación" / "info ok").
- Icono `m-shield-check` en `--teal`.
- Texto inline con: timestamp formateado, "hace X", duración del run, cap
  de spawns usado (`47/60`), modo de concurrencia (`serializado`).
- A la derecha: botón "Ejecutar harness" tipo CTA con icono `m-play`.
- Estado del botón:
  - **Habilitado** (default mostrado): coordinación OK (ver banner 3).
  - **Deshabilitado** (pipeline productivo activo): texto a `--text-dim`,
    borde a `--border-subtle`, tooltip "ejecutar en ventana modo descanso
    o pausa parcial — REQ-SEC-6".

### 3. Banner de coordinación (1392 × 38px) — REQ-SEC-6

- Fondo `--rest-mode-bg` con borde `--rest-mode` (indigo nocturno).
- Icono `m-pause-lock` en `--rest-mode`.
- Texto: estado de la ventana de modo descanso, contenido del
  `.partial-pause.json` allowlist, y aclaración "resto del pipeline pausado".
- A la derecha: tag `REQ-SEC-6` en mono 11px `--text-dim` (trazabilidad al
  análisis de security).

### 4. Leyenda siempre visible (1392 × 74px) — CA-UX-2

Card `--surface-1` con dos filas:

**Fila 1 (Estados):** cinco chips horizontales lado a lado:
- `PASS` verde (`--success`) + glyph `m-cell-pass` (check circular).
- `WARN` amarillo (`--warning`) + glyph `m-cell-warn` (triángulo con !).
- `FAIL` rojo (`--danger`) + glyph `m-cell-fail` (X circular).
- `SKIPPED` gris (`--text-dim`) + glyph `m-cell-skipped` (línea horizontal
  con borde dasheado).
- `N/A` muted (`--border-strong`) + glyph `m-cell-na` (cuadrado con líneas
  diagonales rayadas).

**Fila 2 (Latencia — REQ-SEC-9):** cinco pills con buckets discretos:
- `<100ms` en `--brand-cyan`.
- `<500ms` en `--info`.
- `<2s` en `--text-secondary` (baseline neutro).
- `<10s` en `--warning`.
- `>10s` en `--danger`.

Nota inline al final: "timing oracle bucketizado — REQ-SEC-9 (no se exponen
valores absolutos)". Esta nota es obligatoria — no esconder.

### 5. Matriz de cobertura (1010 × 640px)

Card `--surface-1` con tabla compacta:

- **Header de columnas**: 5 providers con icono color-identitario
  (Anthropic copper, OpenAI-Codex emerald oscuro, Gemini azul claro,
  Cerebras amarillo, NVIDIA NIM verde NVIDIA). El nombre del provider va
  en mayúsculas espaciadas 11px peso 600.
- **Filas**: una por skill LLM (excluye los `deterministic`: build, tester,
  linter, delivery). En el mockup se muestran 9 filas y un separator
  "+ 6 skills más" — el dashboard real renderea las 15 con scroll vertical
  contenido en la card.

**Cada fila** tiene:
- Columna izquierda (220px): nombre del skill en `--text-primary` 13px
  peso 500 + subtítulo con el modelo primary en `--text-dim` 11px.
- Cinco celdas (130 × 34px, gap 20px): una por provider. Cada celda
  contiene:
  - Glyph del estado (22px, color del estado).
  - Texto del estado (11px peso 600 del mismo color).
  - Pill compacta del bucket de latencia (sólo en PASS y WARN) o
    pequeña etiqueta diagnóstica (`timeout · #3680`, `key faltante`,
    etc.) en FAIL/SKIPPED.

**Codificación visual redundante** (regla del design-system §3):
nunca info por color solo. Cada celda combina color + glyph + texto.
El patrón rayado diagonal de `N/A` es no decorativo: identifica
combinaciones que no aplican por diseño (ej. `security` × `gemini`
está excluido por TOS sensible) y debe leerse distinto de `FAIL` o
`SKIPPED`.

**Footer de la card** (separator + 60px): resumen del run con cinco chips
mono (PASS / WARN / FAIL / SKIPPED / N/A) + texto inline "cobertura
efectiva: 85% (39 PASS de 46 esperadas)". El % se calcula sobre
combinaciones aplicables (PASS / (PASS + WARN + FAIL + SKIPPED)) —
N/A no entra en el denominador.

### 6. Panel lateral derecho (362 × 640px) — CA-UX-4 / REQ-SEC-10

Card `--surface-1` con:
- Header: icono `m-issue` rojo + título "Issues auto-creados" + subtítulo
  con conteo de FAILs.
- Lista de cards de issue (92px cada una). Cada card de issue contiene:
  - Título: `#NNNN <descripción corta>` 13px peso 600.
  - Tres líneas mono compactas:
    - `skill: <nombre>` + `provider: <nombre coloreado>`.
    - `error_class: <taxonomía>` (color `--danger`).
    - `evidence: sha256:<8 chars>…<4 chars>` o `latency: <bucket>`.
  - Link out icon (`m-link-out`) en `--info` a la derecha-abajo, abre
    el issue de GitHub.
- Después de las cards: nota "+ N issues más" → link al listado completo
  en `/multi-provider/coverage`.
- Bloque didáctico **REQ-SEC-10**: explicación textual de por qué los
  issues contienen sólo `skill · provider · error_class · latency_bucket
  · evidence_hash` y NUNCA raw output del provider. Es importante que
  esta nota esté visible — no la escondan en un tooltip.
- Bloque "Fuentes de data" al pie del panel: paths mono a la matriz
  JSON, el audit JSONL hash-chain, el doc markdown y mención al hash-chain
  SHA-256 (REQ-SEC-7).

### 7. Tooltip de celda flotante (CA-UX-6)

Cuando el usuario hace hover sobre una celda PASS / WARN / FAIL, aparece
un popover (320 × 180px, `--surface-3` con borde `--purple` para
diferenciarlo del tooltip nativo del browser):
- Pointer line desde el popover hacia la celda hovered.
- Header: icono `m-info` + "Detalle de celda · `<skill>` × `<provider>`".
- Lista mono de campos:
  - `estado`: chip con color del estado.
  - `latencia`: bucket discreto (NUNCA valor absoluto).
  - `divergencia` (sólo en WARN): tipo de divergencia detectada
    (`structural-shape OK · length 3.2× baseline`).
  - `model`: el model_used real (ej. `gemini-2.0-flash-exp`).
  - `timestamp`: hora del run.
  - `evidence`: hash SHA-256 corto.
- Footer con leyenda: "Sin raw output · cumple REQ-SEC-9 (timing
  bucketizado) y REQ-SEC-10 (hash en vez de raw)".

El tooltip se cierra con mouseleave + tecla `Esc`. NO usar tooltips
nativos del browser (`title=`): no soportan estilo y rompen WCAG.

### 8. Footer del widget (1440 × 30px)

Línea mono `--text-dim` 11px con bullets `--border-strong`:
- "Widget consume snapshot persistido (no dispara invocaciones al
  renderizar)".
- "DOM morphing anti-flicker".
- "refresh 30s".
- "cumple R2/R6 #3086 (allowlist providers)".

Segunda línea aún más muted (`--text-disabled`): trazabilidad al mockup
y al issue.

## Estados de cell — tabla canónica

| Estado    | Color principal      | Bg              | Glyph             | Cuándo se emite                                          |
|-----------|----------------------|-----------------|-------------------|----------------------------------------------------------|
| `PASS`    | `--success` (#3FB950)| `--success-bg`  | `m-cell-pass`     | exit=0 + parser OK + SLA ≤ 2× baseline                   |
| `WARN`    | `--warning` (#D29922)| `--warning-bg`  | `m-cell-warn`     | exit=0 pero divergencia OR latencia 2-5× OR warnings     |
| `FAIL`    | `--danger` (#F85149) | `--danger-bg`   | `m-cell-fail`     | exit≠0 OR timeout OR quota OR auth OR parser threw       |
| `SKIPPED` | `--text-dim` (#8B949E)| transparente   | `m-cell-skipped`  | API key faltante o placeholder — no se invoca            |
| `N/A`     | `--border-strong`    | `hatch-na`      | `m-cell-na`       | provider no aplica al skill por diseño (TOS, allowlist)  |

## Iconografía nueva en el sprite

El widget requiere agregar al `sprite.svg` (con sus IDs canónicos):
- `ic-cell-pass`, `ic-cell-warn`, `ic-cell-fail`, `ic-cell-skipped`,
  `ic-cell-na` — glyphs de estado de matriz.
- `ic-play` — botón "Ejecutar harness".
- `ic-pause-lock` — guard de coordinación REQ-SEC-6.
- `ic-link-out` — link a issue de GitHub.

El SVG `23-multi-provider-coverage-widget.svg` los inlines en su `<defs>`
con prefijo `m-` (`m-cell-pass`, etc.) — al portarlos al sprite renombrar
a `ic-*` siguiendo la convención `icons/README.md`.

## Accesibilidad — checklist mínimo

- Cada `<svg>` con `role="img"` y `aria-label` descriptivo del **estado**,
  no del dibujo. Ejemplos:
  - `aria-label="celda backend-dev × cerebras: PASS, latencia menor a 500ms"`.
  - `aria-label="celda review × openai-codex: FAIL, timeout, ver issue 3680"`.
- La matriz envuelta en `<table>` real (con `<thead>` y `<tbody>`), NO en
  divs anidados. El render visual es CSS grid, pero el DOM mantiene la
  semántica de tabla para screen readers.
- Las celdas `N/A` deben tener `aria-label="no aplicable: provider no
  configurado para este skill"` — no leerse como "vacío".
- Contraste mínimo 4.5:1 para texto normal, 3:1 para texto grande / glyphs.
  Todos los pares verificados (ver header del SVG).
- Hovered cell debe mostrar focus visible (outline `--brand-cyan` 2px) además
  del tooltip, para navegación con teclado.

## Comportamiento del botón "Ejecutar harness"

- **Click cuando coordinación OK**:
  1. Confirma con dialog modal: "Va a correr ~20 min consumiendo cuota de
     todos los providers (cap 60 spawns). Estás seguro?".
  2. POST a `/api/dash/multi-provider/run`.
  3. Botón pasa a estado "Corriendo · X / 60 spawns" con barra de progreso.
  4. Al terminar: refresh automático de la matriz + sign-off Telegram via
     queue de filesystem (REQ-SEC-8 — NO curl directo).
- **Click cuando coordinación NO OK** (pipeline productivo activo):
  1. Modal explica por qué no se puede ejecutar.
  2. Link a `/leyenda#modo-descanso` para entender ventanas.
  3. Botón sigue deshabilitado hasta que la coordinación cambie.

## Refresh / live update

- El widget hace polling cada 30s al endpoint
  `/api/dash/multi-provider-coverage` (JSON).
- Aplica DOM morphing anti-flicker (patrón establecido en #2801): no
  re-renderea desde cero, sólo actualiza celdas cambiadas.
- El timestamp "hace X" se recalcula client-side cada 10s sin pegar al
  endpoint.

## Trazabilidad

- **Mockup**: `.pipeline/assets/mockups/23-multi-provider-coverage-widget.svg`
- **Issue**: [#3669](https://github.com/intrale/platform/issues/3669)
- **Análisis técnico**: comentario del agente `guru` en el issue.
- **Análisis de seguridad**: comentario del agente `security` en el issue.
- **Design tokens**: `.pipeline/assets/design-tokens.css` familias 3.c y
  3.d (providers) + 3 (semánticos).
- **Iconografía**: `.pipeline/assets/icons/sprite.svg` (al agregar los
  nuevos glyphs durante implementación).
- **Doc del sistema visual**: `docs/pipeline/design-system.md`.
